import jsxA11y from "eslint-plugin-jsx-a11y";
import coreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// eslint-config-next@16 exports native FLAT configs (arrays of config
// objects). The previous version of this file pushed them through
// `FlatCompat.extends(...)` — which is only for LEGACY eslintrc-format
// shareable configs — and ESLint 9 crashed with "Converting circular
// structure to JSON" while validating the flat config through the legacy
// validator. Importing the flat configs directly fixes the crash.
const eslintConfig = [
  {
    ignores: [
      ".next/",
      "node_modules/",
      "out/",
      "next-env.d.ts",
      "cli/",
      "mini-services/",
      "skills/",
      "examples/",
    ],
  },
  ...coreWebVitals,
  ...nextTypescript,
  // Accessibility: enforce the jsx-a11y recommended ruleset explicitly.
  // next/core-web-vitals registers the "jsx-a11y" plugin (scoped to JS/TS
  // files) but only enables a small subset of its rules; we enable the full
  // recommended ruleset for the same file set. The plugin itself must NOT be
  // redeclared here — ESLint refuses to redefine an already-registered
  // plugin, and rules resolve against the earlier registration.
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // High-value rules — keep as errors so they block the build.
      "jsx-a11y/alt-text": "error",
      "jsx-a11y/label-has-associated-control": [
        "error",
        {
          // Treat these custom/Radix form controls as valid label targets so
          // labels that wrap them aren't flagged as orphaned.
          controlComponents: ["Checkbox", "Switch", "RadioGroupItem", "Slider"],
          assert: "either",
          // Radio "card" labels wrap the input plus a rich description block
          // (div > div > text), so the accessible text sits at depth 3.
          depth: 4,
        },
      ],
      "jsx-a11y/aria-props": "error",
      "jsx-a11y/aria-proptypes": "error",
      "jsx-a11y/aria-unsupported-elements": "error",
      "jsx-a11y/role-has-required-aria-props": "error",
      "jsx-a11y/role-supports-aria-props": "error",
      "jsx-a11y/anchor-has-content": "error",
      "jsx-a11y/heading-has-content": "error",
      // Noisier / structural rules — surface as warnings so they're visible
      // without blocking the build. These typically require larger refactors
      // (keyboard handlers, captions, native-element swaps) to satisfy.
      "jsx-a11y/no-autofocus": "warn",
      "jsx-a11y/click-events-have-key-events": "warn",
      "jsx-a11y/no-static-element-interactions": "warn",
      "jsx-a11y/no-noninteractive-element-interactions": "warn",
      "jsx-a11y/media-has-caption": "warn",
      // Fires on a custom <CaseStudy role="COO" /> prop (job title, not an
      // ARIA role); downgraded to a warning to avoid the false positive.
      "jsx-a11y/aria-role": ["warn", { ignoreNonDOM: true }],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          destructuredArrayIgnorePattern: "^_",
        },
      ],
    },
  },
];

export default eslintConfig;
