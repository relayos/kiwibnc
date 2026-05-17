const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');
const webchatDir = path.join(repoRoot, 'src/extensions/webchat');

describe('RelayBNC custom module packaging', () => {
    test('vendors a ci-safe relaybnc custom module snapshot instead of a private submodule', () => {
        expect(fs.existsSync(path.join(repoRoot, '.gitmodules'))).toBe(false);
        expect(fs.existsSync(path.join(repoRoot, 'custom-modules/.git'))).toBe(false);

        const gitmodules = fs.existsSync(path.join(repoRoot, '.gitmodules'))
            ? fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8')
            : '';
        expect(gitmodules).not.toContain('https://github.com/relayos/custom-modules.git');
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

    test('packages RelayOS webchat OAuth overlay in custom modules', () => {
        const overlayDir = path.join(repoRoot, 'custom-modules/kiwibnc/extensions/webchat');

        expect(fs.existsSync(path.join(overlayDir, 'routes_oauth.js'))).toBe(true);
        expect(fs.existsSync(path.join(overlayDir, 'routes_client.js'))).toBe(true);
        expect(fs.existsSync(path.join(overlayDir, 'index.js'))).toBe(true);
        expect(fs.existsSync(path.join(overlayDir, 'kiwibnc_plugin.html'))).toBe(true);
    });

    test('keeps RelayOS OAuth webchat policy out of core source', () => {
        const routesClient = fs.readFileSync(path.join(webchatDir, 'routes_client.js'), 'utf8');
        const webchatIndex = fs.readFileSync(path.join(webchatDir, 'index.js'), 'utf8');
        const pluginHtml = fs.readFileSync(path.join(webchatDir, 'kiwibnc_plugin.html'), 'utf8');

        expect(fs.existsSync(path.join(webchatDir, 'routes_oauth.js'))).toBe(false);
        expect(routesClient).not.toContain('oauthClientConf');
        expect(routesClient).not.toContain('oauthEnabled');
        expect(webchatIndex).not.toContain('routes_oauth');
        expect(pluginHtml).not.toContain('kiwibnc_oauth_login');
    });

    test('keeps WordPress user linkage out of core source', () => {
        const coreFiles = [
            'src/libs/dataModels/user.js',
            'src/worker/users.js',
            'src/dbschemas/users/20260516190000_wordpress_user_fk.js',
            'src/dbschemas/users/20260516201000_bnc_child_fks.js',
        ];

        for (const file of coreFiles) {
            const fullPath = path.join(repoRoot, file);
            if (!fs.existsSync(fullPath)) {
                continue;
            }

            const text = fs.readFileSync(fullPath, 'utf8');
            expect(text).not.toContain('wp_user_id');
            expect(text).not.toContain('wp_users');
        }
    });

    test('template disables sqlite message logging for custom message store ownership', () => {
        const template = fs.readFileSync(
            path.join(repoRoot, 'src/configProfileTemplate/config.ini'),
            'utf8'
        );

        expect(template).not.toMatch(/^database="\.\/messages\.db"$/m);
        expect(template).toContain('#database="./messages.db"');
        expect(template).toContain('[message_store_mariadb]');
        expect(template).toContain('messages_table="bnc_messages"');
    });
});
