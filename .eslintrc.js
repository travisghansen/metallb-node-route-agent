module.exports = {
  parser: 'esprima', //default parser
  parserOptions: {
    ecmaVersion: 10,
    ecmaFeatures: {
      jsx: true
    }
  },
  env: {
    node: true,
    es6: true
  },
  plugins: ['prettier'],
  extends: ['eslint:recommended', 'prettier'],
  rules: {
    'no-unreachable': 2,
    'no-console': 1, // Means warning
    'prettier/prettier': 2 // Means error
  }
};
