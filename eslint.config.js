import globals from "globals";
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: { globals: { ...globals.browser, __TEST__: "readonly" } },
    rules: {
      "no-undef": "error",
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none" }],
    },
  },
];
