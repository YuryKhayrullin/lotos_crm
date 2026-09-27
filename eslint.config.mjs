import nextConfig from 'eslint-config-next'

const config = [
  ...nextConfig,
  {
    ignores: ['.next/**', '.test-dist/**', 'node_modules/**', 'backend/**', 'public/**', 'tsconfig.tsbuildinfo'],
  },
]

export default config
