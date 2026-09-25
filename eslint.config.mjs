import nextConfig from "eslint-config-next/core-web-vitals";

export default [
  ...nextConfig,
  { ignores: [".next/**", "out/**", "build/**", "components/ui/**"] },
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "import/no-anonymous-default-export": "off",
    },
  },
];
