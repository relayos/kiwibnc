const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

describe('custom module packaging', () => {
    test('vendors a ci-safe custom module snapshot instead of a private submodule', () => {
        expect(fs.existsSync(path.join(repoRoot, '.gitmodules'))).toBe(false);
        expect(fs.existsSync(path.join(repoRoot, 'custom-modules/.git'))).toBe(false);

        const gitmodules = fs.existsSync(path.join(repoRoot, '.gitmodules'))
            ? fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8')
            : '';
        expect(gitmodules).not.toContain('custom-modules.git');
    });

    test('runs validation on feature branch pushes while publishing only master', () => {
        const woodpecker = fs.readFileSync(path.join(repoRoot, '.woodpecker.yml'), 'utf8');

        expect(woodpecker).toContain('event: [push, pull_request]');
        expect(woodpecker).not.toMatch(/^when:\n\s+- event: \[push, pull_request\]\n\s+branch: \[master\]/m);
        expect(woodpecker).toMatch(/name: publish-image[\s\S]*branch: \[master\]/);
    });

    test('does not require private custom-modules checkout during ci clone', () => {
        const woodpecker = fs.readFileSync(path.join(repoRoot, '.woodpecker.yml'), 'utf8');

        expect(woodpecker).toContain('recursive: false');
        expect(woodpecker).not.toContain('name: custom-modules-checkout');
        expect(woodpecker).not.toContain('git submodule update');
        expect(woodpecker).toContain("python3 -m unittest discover -s custom-modules/tests -p 'test_kiwibnc_*.py' -v");
    });

    test('custom module validation has both node and python available', () => {
        const woodpecker = fs.readFileSync(path.join(repoRoot, '.woodpecker.yml'), 'utf8');

        expect(woodpecker).toMatch(/name: custom-modules-validation[\s\S]*image: node:20-alpine/);
        expect(woodpecker).toMatch(/name: custom-modules-validation[\s\S]*apk add --no-cache python3/);
    });

    test('vendors only KiwiBNC custom module contract tests', () => {
        const testsDir = path.join(repoRoot, 'custom-modules/tests');
        const contractTests = fs.readdirSync(testsDir)
            .filter((name) => /^test_.*\.py$/.test(name));

        expect(contractTests).toEqual(expect.arrayContaining([
            'test_kiwibnc_entitlements_contract.py',
            'test_kiwibnc_mariadb_message_store_contract.py',
            'test_kiwibnc_offline_messaging_contract.py',
            'test_kiwibnc_webchat_oauth_overlay_contract.py',
        ]));
        expect(contractTests.every((name) => name.startsWith('test_kiwibnc_'))).toBe(true);
        expect(contractTests).not.toEqual(expect.arrayContaining([
            'test_inspircd_module_contract.py',
            'test_kiwi_overlay_contract.py',
        ]));
    });

    test('copies KiwiBNC custom modules into the runtime source tree', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

        expect(dockerfile).toContain('COPY custom-modules/kiwibnc/ /app/src/');
        expect(dockerfile).toContain('/app/src/worker/messagestores/mariadb.js');
    });

    test('packages RelayBNC entitlement resolver and badges', () => {
        expect(fs.existsSync(path.join(repoRoot, 'custom-modules/kiwibnc/libs/relayos_entitlements.js'))).toBe(true);
        expect(fs.existsSync(path.join(repoRoot, 'custom-modules/kiwibnc/extensions/webchat/relayos_badges.js'))).toBe(true);
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');
        expect(dockerfile).toContain('COPY custom-modules/kiwibnc/ /app/src/');
    });

    test('keeps custom message-store defaults out of core config template', () => {
        const template = fs.readFileSync(
            path.join(repoRoot, 'src/configProfileTemplate/config.ini'),
            'utf8'
        );

        expect(template).toMatch(/^public_register = true$/m);
        expect(template).toMatch(/^database="\.\/messages\.db"$/m);
        expect(template).not.toContain('[message_store_mariadb]');
        expect(template).not.toContain('messages_table="bnc_messages"');
    });

    test('loads the offline messaging extension in the default config template', () => {
        const template = fs.readFileSync(
            path.join(repoRoot, 'src/configProfileTemplate/config.ini'),
            'utf8'
        );
        const extensionsSection = template.match(/^\[extensions\]\nloaded = \[([\s\S]*?)\]/m);

        expect(extensionsSection).not.toBeNull();
        expect(extensionsSection[1]).toContain('"offline-messaging"');
    });
});
