module.exports = {
  root: true,
  env: {
    es6: true,
    node: true,
  },
  extends: [
    "eslint:recommended",
    "plugin:import/errors",
    "plugin:import/warnings",
    "plugin:import/typescript",
    "google",
    "plugin:@typescript-eslint/recommended",
  ],
  parser: "@typescript-eslint/parser",
  parserOptions: {
    project: ["tsconfig.json", "tsconfig.dev.json"],
    sourceType: "module",
  },
  ignorePatterns: [
    "/lib/**/*", // Ignore built files.
  ],
  plugins: [
    "@typescript-eslint",
    "import",
  ],
  rules: {
    "quotes": "warn",
    "linebreak-style": "off",
    "max-len": ["warn", { "code": 120 }],
    "@typescript-eslint/no-non-null-assertion": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "indent": ["error", 2],
    "object-curly-spacing": "warn",
    "comma-dangle": "warn",
    "require-jsdoc": "warn",
    "new-cap": "warn",
    "no-trailing-spaces": "warn",
    "arrow-parens": "warn",
    "prefer-const": "warn"
  },
};
