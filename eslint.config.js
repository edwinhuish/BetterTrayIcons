import {defineConfig} from 'eslint/config';
import gnome from 'eslint-config-gnome';

export default defineConfig([
    {
        ignores: ['locale/'],
    },
    gnome.configs.recommended,
    {
        files: ['scripts/**/*.mjs'],
        languageOptions: {
            globals: {
                process: 'readonly',
            },
        },
    },
    {
        rules: {
            camelcase: ['error', {
                properties: 'never',
            }],
            'consistent-return': 'error',
            eqeqeq: ['error', 'smart'],
            'key-spacing': ['error', {
                mode: 'minimum',
                beforeColon: false,
                afterColon: true,
            }],
            'prefer-arrow-callback': 'error',
            'prefer-const': ['error', {
                destructuring: 'all',
            }],
        },
        languageOptions: {
            globals: {
                global: 'readonly',
            },
        },
    },
]);
