/**
 * Layering rules: common <- infra <- modules <- workers. Run with `npm run depcruise`.
 * @type {import('dependency-cruiser').IConfiguration}
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment: 'Circular imports make module load order fragile.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'common-is-a-leaf',
      severity: 'error',
      comment: 'src/common holds shared helpers and must not reach into infra or feature modules.',
      from: { path: '^src/common' },
      to: { path: '^src/(infra|modules|workers)' },
    },
    {
      name: 'infra-does-not-know-features',
      severity: 'error',
      comment:
        'Infrastructure (database, storage, mail, queues) must not import feature modules. Route decorators are plain metadata and allowed (the metrics endpoint is @Public).',
      from: { path: '^src/infra' },
      to: { path: '^src/(modules|workers)', pathNot: '^src/modules/auth/decorators\\.ts$' },
    },
    {
      name: 'modules-do-not-import-workers',
      severity: 'error',
      from: { path: '^src/modules' },
      to: { path: '^src/workers' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: 'tsconfig.json' },
    exclude: { path: '\\.spec\\.ts$' },
  },
};
