import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, it } from 'vitest';

// test/unit/nativeAudio/workflow.test.ts — publishing must depend on every verification gate.
const { load: parse } = createRequire(import.meta.url)('js-yaml');
const workflow = parse(readFileSync('.github/workflows/native-component.yml', 'utf8'));
const dependencies = (job: string): string[] => {
    const needs = workflow.jobs[job].needs ?? [];
    return Array.isArray(needs) ? needs : [needs];
};
it('cannot prepare or publish when overall verification fails', () => {
    expect(dependencies('prepare-mirror')).toContain('verify');
    expect(dependencies('publish-mirror')).toContain('prepare-mirror');
    for (const job of ['prepare-mirror', 'publish-mirror']) {
        expect(workflow.jobs[job].if ?? '').not.toMatch(/always\(|failure\(|cancelled\(/);
    }
});
it('requires an explicit catalog baseline for manual publishing as well as pull requests', () => {
    expect(workflow.on.workflow_dispatch.inputs.catalog_base.required).toBe(true);
    const check = workflow.jobs.verify.steps.find((step: { name?: string }) => step.name === 'Check retained compatible catalog');
    expect(check.env.BASE_SHA).toContain('github.event.pull_request.base.sha');
    expect(check.env.BASE_SHA).toContain('inputs.catalog_base');
    expect(check.run).toContain('$env:BASE_SHA');
});
it('restricts publishing preparation to the upstream main branch', () => {
    expect(workflow.jobs['prepare-mirror'].if).toContain("github.repository == 'chthollyphile/folia-major'");
    expect(workflow.jobs['prepare-mirror'].if).toContain("github.ref == 'refs/heads/main'");
    expect(workflow.jobs['publish-mirror'].permissions.contents).toBe('write');
});
