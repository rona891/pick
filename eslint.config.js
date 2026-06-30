import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    files: ["frontend/js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      // Los archivos son scripts del browser (no módulos ES), pero los usamos como
      // múltiples <script> que comparten el scope global. ESLint no puede rastrear
      // referencias cross-file, así que no-undef va en warn, no error.
      sourceType: "script",
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { varsIgnorePattern: "^_", argsIgnorePattern: "^_" }],
      "no-undef": "warn",
      "no-console": "off",
      "eqeqeq": ["warn", "always"],
    },
  },
];
