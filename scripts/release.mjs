#!/usr/bin/env node
// Cuts a release. The flow deliberately avoids npm's own `version` command:
// package managers run scripts differently (pnpm resolved the npm-version based
// flow straight to the version hook, so the bump, commit and tag never
// happened), and the version does not live in package.json alone anyway.
//
//   node scripts/release.mjs 3.3.0 [--push] [--dry-run]
//   node scripts/release.mjs minor|patch|major
//
// The version GNOME Shell, extensions.gnome.org and the About page show lives
// in metadata.json's "version-name", release-please keeps a copy in the
// manifest, and CHANGELOG.md documents the cut. All four files are updated and
// land in the release commit the tag points at.

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync} from 'node:fs';
import readline from 'node:readline';
import {stdin as input, stdout as output} from 'node:process';

const PACKAGE_FILE = 'package.json';
const METADATA_FILE = 'metadata.json';
const MANIFEST_FILE = '.github/.release-please-manifest.json';
const CHANGELOG_FILE = 'CHANGELOG.md';

// Mirrors .github/release-please-config.json: the sections a release lists, in
// its order, and the types it keeps out of the changelog entirely.
const SECTIONS = [
    ['Features', ['feat', 'feature']],
    ['Bug Fixes', ['fix']],
    ['Performance Improvements', ['perf']],
    ['Reverts', ['revert']],
    ['Translations', ['i18n', 'l10n', 'translation', 'translate']],
];

const HIDDEN_TYPES = new Set(['docs', 'style', 'chore', 'refactor', 'test', 'build', 'ci']);

const SUBJECT_PATTERN = /^([A-Za-z]+)(?:\(([^)]*)\))?(!)?:\s+(.+)$/;
const RELEASE_SUBJECT_PATTERN = /^chore\(main\):\s*release\s/;
const PULL_REQUEST_SUFFIX_PATTERN = /\s+\(#\d+\)$/;
const BREAKING_CHANGE_PATTERN = /^BREAKING[ -]CHANGE:/m;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;
const BUMP_TYPES = new Set(['patch', 'minor', 'major']);

// Failures a user can act on print as a clean one-liner; anything else is a
// bug in this script and keeps its stack trace.
class ReleaseError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ReleaseError';
    }
}

const RED = output.isTTY ? '\u001b[31m' : '';
const RESET = output.isTTY ? '\u001b[0m' : '';

async function main() {
    const {version: requested, push, dryRun} = parseArgs(process.argv.slice(2));
    const current = readCurrentVersion();

    try {
        // A dirty tree or a non-main branch is reported before the interactive
        // pick, so nobody chooses a version and then gets thrown out. A dry
        // run skips them and answers questions on a dirty tree too.
        if (!dryRun) {
            assertCleanTree();
            warnIfNotMain();
        }

        const base = repositoryBase();
        const previous = previousReleaseRef(current);
        const {grouped, breakingEntries, counted} = collectEntries(previous, base);
        if (!counted && !breakingEntries.length) {
            fail(`Nothing to release: no feat/fix/perf/revert/i18n commit since ${previous}. ` +
                'Chores, docs and tests alone do not cut a release.');
        }

        // The commits suggest where to start: a breaking change a major, a
        // feature a minor, everything else a patch.
        let suggested = 'patch';
        if (breakingEntries.length)
            suggested = 'major';
        else if (grouped.get('Features').length)
            suggested = 'minor';

        let version;
        try {
            version = requested
                ? assertNewer(resolveVersion(requested, current), current)
                : await chooseVersion(current, suggested);
        } catch (error) {
            if (!error.cancelled)
                throw error;
            console.log('Release cancelled.');
            return;
        }
        assertTagFree(version);

        const breaking = breakingEntries.length;
        const block = buildBlock(version, current, base, grouped, breakingEntries);

        if (dryRun) {
            console.log(`dry run: ${current} -> ${version}, ` +
                `${counted} entries, ${breaking} breaking, tag v${version}`);
            console.log(block);
            return;
        }

        writePackageVersion(version);
        writeMetadata(version);
        writeManifest(version);
        writeChangelog(block);

        git(['add', PACKAGE_FILE, METADATA_FILE, MANIFEST_FILE, CHANGELOG_FILE]);
        git(['commit', '-m', `chore(main): release ${version}`]);
        git(['tag', '-a', `v${version}`, '-m', `Better Tray Icons ${version}`]);

        const suffix = breaking ? `, with ${breaking} breaking change${breaking === 1 ? '' : 's'}` : '';
        console.log(`Released ${version} (${counted} entr${counted === 1 ? 'y' : 'ies'}${suffix}) since ${previous}.`);
        if (push)
            pushRelease(version);
        else
            console.log('Now run: git push --follow-tags');
    } catch (error) {
        report(error);
    }
}

function parseArgs(args) {
    let version = null;
    let push = false;
    let dryRun = false;

    for (const arg of args) {
        // pnpm forwards a separating -- along with the rest, npm strips it.
        if (arg === '--')
            continue;
        if (arg === '--push')
            push = true;
        else if (arg === '--dry-run')
            dryRun = true;
        else if (arg.startsWith('-'))
            fail(`unknown option '${arg}'`);
        else if (version)
            fail('give one version or release type');
        else
            version = arg;
    }

    return {version, push, dryRun};
}

function readCurrentVersion() {
    const version = JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'))['.'];
    if (!VERSION_PATTERN.test(version ?? ''))
        fail(`${MANIFEST_FILE} holds no usable version`);
    return version;
}

function resolveVersion(requested, current) {
    if (!requested)
        fail('give a version (3.3.0) or a release type (patch, minor, major)');

    const type = requested.toLowerCase();
    if (BUMP_TYPES.has(type))
        return bump(current, type);

    const version = requested.replace(/^v/, '');
    if (!VERSION_PATTERN.test(version))
        fail(`'${requested}' is neither a release type nor a x.y.z version`);
    return version;
}

function bump(current, type) {
    const [major, minor, patch] = current.split('.').map(Number);
    if (type === 'major')
        return `${major + 1}.0.0`;
    if (type === 'minor')
        return `${major}.${minor + 1}.0`;
    return `${major}.${minor}.${patch + 1}`;
}

function assertNewer(version, current) {
    const left = version.split('.').map(Number);
    const right = current.split('.').map(Number);
    const order = (left[0] - right[0]) || (left[1] - right[1]) || (left[2] - right[2]);
    if (order === 0)
        fail(`${version} is already released`);
    if (order < 0)
        fail(`${version} is older than the released ${current}`);
    return version;
}

// Every change has to be committed, an untracked file is a missed file too.
function assertCleanTree() {
    const status = git(['status', '--porcelain']).trim();
    if (status)
        fail(`the working tree is not clean, commit or stash first:\n${status}`);
}

function assertTagFree(version) {
    const tag = `v${version}`;
    if (git(['tag', '-l', tag]).trim())
        fail(`tag ${tag} already exists`);
}

function warnIfNotMain() {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    if (branch !== 'main')
        console.warn(`Releasing from '${branch}': the release workflows only run on main.`);
}

// The cut of the version that is being replaced: a local tag when there is one,
// otherwise the release commit release-please made for it.
function previousReleaseRef(current) {
    try {
        const tag = git(['describe', '--tags', '--abbrev=0', '--match', 'v*'], {quiet: true}).trim();
        if (tag)
            return tag;
    } catch {
        // This clone carries no tags, the release commit below still marks the cut.
    }

    const pattern = new RegExp(`^chore\\(main\\):\\s*release\\s+v?${escapeRegExp(current)}(?:\\s|$)`);
    for (const line of git(['log', '--format=%H%x1f%s', '-n', '5000']).split('\n')) {
        const [sha, subject = ''] = line.split('\x1f');
        if (sha && pattern.test(subject))
            return sha;
    }

    throw new ReleaseError(`cannot tell where ${current} was cut: no v* tag and no release commit found`);
}

function collectEntries(previous, base) {
    const grouped = new Map(SECTIONS.map(([title]) => [title, []]));
    const breakingEntries = [];
    let counted = 0;

    const raw = git(['log', '--no-merges', `${previous}..HEAD`, '--format=%H%x1f%s%x1f%b%x1e']);
    for (const item of raw.split('\x1e')) {
        // git separates the records with newlines, and they land inside the
        // first field unless the record is trimmed first.
        const record = item.trim();
        if (!record)
            continue;

        const [sha, subject = '', ...rest] = record.split('\x1f');
        const cleanSubject = subject.trim();
        // A release commit inside the range would be a stale marker, never content.
        if (RELEASE_SUBJECT_PATTERN.test(cleanSubject))
            continue;

        const match = cleanSubject.match(SUBJECT_PATTERN);
        if (!match)
            continue; // Not a conventional commit, release-please ignores it too.

        const text = match[4].replace(PULL_REQUEST_SUFFIX_PATTERN, '');
        const entry = `${match[2] ? `**${match[2]}:** ` : ''}${text}${commitLink(sha, base)}`;

        if (match[3] === '!' || BREAKING_CHANGE_PATTERN.test(rest.join('\x1f'))) {
            breakingEntries.push(entry);
            continue;
        }

        const title = sectionFor(match[1].toLowerCase());
        if (!title)
            continue; // A hidden type: it ships, but stays out of the changelog.

        grouped.get(title).push(entry);
        counted++;
    }

    return {grouped, breakingEntries, counted};
}

// A bare `pnpm release` asks instead of failing: the arrow keys pick the bump
// and the commits suggest where to start. Piped or CI shells cannot answer a
// prompt, so they keep the explicit-version error.
function chooseVersion(current, suggested) {
    if (!input.isTTY)
        fail('give a version (3.3.0) or a release type (patch, minor, major)');

    const choices = [...BUMP_TYPES].map(type => ({type, version: bump(current, type)}));
    const height = choices.length + 1;
    let index = Math.max(0, choices.findIndex(choice => choice.type === suggested));

    readline.emitKeypressEvents(input);
    input.setRawMode(true);
    input.resume();
    draw();

    return new Promise((resolve, reject) => {
        const onKey = (character, key) => {
            if (key.ctrl && key.name === 'c')
                cancel();
            else if (key.name === 'up' || key.name === 'k')
                move(-1);
            else if (key.name === 'down' || key.name === 'j')
                move(1);
            else if (key.name === 'return' || key.name === 'enter')
                settle(choices[index].version);
            else if (key.name === 'escape')
                cancel();
        };
        const move = step => {
            index = (index + step + choices.length) % choices.length;
            redraw();
        };
        const settle = version => {
            finish();
            output.write(`  ${version}\n`);
            resolve(version);
        };
        const cancel = () => {
            finish();
            output.write('  cancelled\n');
            reject(Object.assign(new Error('cancelled'), {cancelled: true}));
        };
        const finish = () => {
            input.removeListener('keypress', onKey);
            if (input.isTTY)
                input.setRawMode(false);
            input.pause();
            clearLines();
        };

        input.on('keypress', onKey);
    });

    function draw() {
        for (const [position, choice] of choices.entries())
            output.write(`${position === index ? '\u001b[36m❯\u001b[0m' : ' '} ${choice.type.padEnd(5)} ${choice.version}\n`);
        output.write('  ↑/↓ choose, enter confirm, esc cancel\n');
    }

    function redraw() {
        clearLines();
        draw();
    }

    function clearLines() {
        output.write(`\u001b[${height}A\u001b[0J`);
    }
}

function sectionFor(type) {
    if (HIDDEN_TYPES.has(type))
        return null;
    return SECTIONS.find(([, types]) => types.includes(type))?.[0] ?? null;
}

function commitLink(sha, base) {
    return base ? ` ([${sha.slice(0, 7)}](${base}/commit/${sha}))` : ` (${sha.slice(0, 7)})`;
}

// Same shape release-please leaves behind: the compare header, two blanks, then
// one section per type with a blank line between entries and the next release.
function buildBlock(version, current, base, grouped, breakingEntries) {
    const header = base
        ? `## [${version}](${base}/compare/v${current}...v${version})`
        : `## ${version}`;
    let block = `${header} (${today()})\n\n\n`;

    if (breakingEntries.length)
        block += `### ⚠ BREAKING CHANGES\n\n${list(breakingEntries)}`;

    for (const [title] of SECTIONS) {
        const entries = grouped.get(title);
        if (entries.length)
            block += `### ${title}\n\n${list(entries)}`;
    }
    return block;
}

function list(entries) {
    return `${entries.map(entry => `* ${entry}`).join('\n')}\n\n`;
}

function today() {
    const now = new Date();
    const pad = part => String(part).padStart(2, '0');
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function writePackageVersion(version) {
    const content = readFileSync(PACKAGE_FILE, 'utf8');
    const pattern = /("version"\s*:\s*")[^"]*(")/;
    if (!pattern.test(content))
        fail(`${PACKAGE_FILE} has no "version" to update`);
    writeFileSync(PACKAGE_FILE, content.replace(pattern, `$1${version}$2`));
}

function writeMetadata(version) {
    const content = readFileSync(METADATA_FILE, 'utf8');
    const pattern = /("version-name"\s*:\s*")[^"]*(")/;
    if (!pattern.test(content))
        fail(`${METADATA_FILE} has no "version-name" to update`);
    writeFileSync(METADATA_FILE, content.replace(pattern, `$1${version}$2`));
    // A malformed manifest would break every later release, catch it here.
    JSON.parse(readFileSync(METADATA_FILE, 'utf8'));
}

function writeManifest(version) {
    const content = readFileSync(MANIFEST_FILE, 'utf8');
    const pattern = /"\d+\.\d+\.\d+"/;
    if (!pattern.test(content))
        fail(`${MANIFEST_FILE} has no version to update`);
    writeFileSync(MANIFEST_FILE, content.replace(pattern, `"${version}"`));
    JSON.parse(readFileSync(MANIFEST_FILE, 'utf8'));
}

function writeChangelog(block) {
    const content = readFileSync(CHANGELOG_FILE, 'utf8');
    const heading = '# Changelog';
    const cut = content.indexOf('\n');
    if (!content.startsWith(heading) || cut === -1)
        fail(`${CHANGELOG_FILE} must start with a "${heading}" heading`);

    const rest = content.slice(cut + 1).replace(/^\n+/, '');
    writeFileSync(CHANGELOG_FILE, `${heading}\n\n${block}${rest}`);
}

function pushRelease(version) {
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const remote = git(['for-each-ref', '--format=%(upstream:remote)', `refs/heads/${branch}`]).trim() || 'origin';
    git(['push', remote, branch]);
    git(['push', remote, `v${version}`]);
}

function git(args, {quiet = false} = {}) {
    // A quiet call expects to fail (probing for a tag), its stderr is noise.
    const stdio = quiet ? ['ignore', 'pipe', 'ignore'] : 'pipe';
    return execFileSync('git', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio});
}

function repositoryBase() {
    // A fork's origin points at the fork, where the release tags may not exist,
    // so an upstream remote wins when there is one.
    for (const remote of ['upstream', 'origin']) {
        try {
            const url = git(['remote', 'get-url', remote]).trim();
            const match = url.match(/github\.com[/:](.+?)(?:\.git)?\/?$/);
            if (match)
                return `https://github.com/${match[1]}`;
        } catch {
            // No such remote, try the next one.
        }
    }
    return '';
}

function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function fail(message) {
    throw new ReleaseError(message);
}

function report(error) {
    // Not a ReleaseError means this script broke, the stack is the useful part.
    if (!(error instanceof ReleaseError))
        throw error;

    const [first, ...rest] = error.message.split('\n');
    console.error(`${RED}✖${RESET} Release failed: ${first}`);
    for (const line of rest)
        console.error(`  ${line}`);
    process.exitCode = 1;
}

await main();
