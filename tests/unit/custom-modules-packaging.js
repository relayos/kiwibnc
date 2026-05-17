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

    test('copies KiwiBNC custom modules into the runtime source tree', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

        expect(dockerfile).toContain('COPY custom-modules/kiwibnc/ /app/src/');
        expect(dockerfile).toContain('/app/src/worker/messagestores/mariadb.js');
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
});
