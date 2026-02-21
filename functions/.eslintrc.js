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
    "quotes": "off",
    "import/no-unresolved": 0,
    "indent": ["warn", 2],
    "linebreak-style": "off",
    "max-len": "off",
    "no-trailing-spaces": "off",
    "comma-dangle": "off",
    "object-curly-spacing": "off",
    "require-jsdoc": "off",
    "new-cap": "off",
    "arrow-parens": "off",
    "prefer-const": "warn",
    "@typescript-eslint/no-explicit-any": "warn",
    "@typescript-eslint/no-non-null-assertion": "warn",
  },
};
