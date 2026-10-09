/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ['@commitlint/config-conventional'],
  plugins: [
    {
      rules: {
        'subject-has-chinese': ({ subject }) => {
          if (!subject) {
            return [false, 'subject 不能为空'];
          }
          const ok = /\p{Script=Han}/u.test(subject);
          return [ok, 'subject 必须包含中文'];
        },
      },
    },
  ],
  rules: {
    // 允许中文 subject；不强制英文 case
    'subject-case': [0],
    'scope-case': [0],
    'subject-empty': [2, 'never'],
    'subject-full-stop': [2, 'never'],
    'subject-has-chinese': [2, 'always'],
    'type-empty': [2, 'never'],
    'type-case': [2, 'always', 'lower-case'],
    'subject-max-length': [2, 'always', 100],
    'header-max-length': [2, 'always', 120],
    'body-max-line-length': [2, 'always', 100],
    'footer-max-line-length': [2, 'always', 100],
    'type-enum': [
      2,
      'always',
      [
        'feat',
        'fix',
        'docs',
        'style',
        'refactor',
        'perf',
        'test',
        'build',
        'ci',
        'chore',
        'revert',
      ],
    ],
  },
};
