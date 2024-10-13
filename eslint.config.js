import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: {
        ...globals.node,
        ...globals.express,
      },
    },
    rules: {
      // Basic rules
      "indent": ["error", 2],
      "quotes": ["error", "single"],
      "semi": ["error", "always"],

      // Node.js and Express specific rules
      "no-unused-vars": ["warn"],
      "no-process-env": "warn",
      "no-sync": "warn",
      "consistent-return": "error",

      // Security rules (without relying on eslint-plugin-security)
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",
    },
  },
];