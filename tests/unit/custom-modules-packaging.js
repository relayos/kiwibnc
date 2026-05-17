const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

describe('RelayBNC custom module packaging', () => {
    test('tracks relayos custom-modules as a submodule', () => {
        const gitmodules = fs.readFileSync(path.join(repoRoot, '.gitmodules'), 'utf8');

        expect(gitmodules).toContain('[submodule "custom-modules"]');
        expect(gitmodules).toContain('path = custom-modules');
        expect(gitmodules).toContain('url = https://github.com/relayos/custom-modules.git');
    });

    test('copies KiwiBNC custom modules into the runtime source tree', () => {
        const dockerfile = fs.readFileSync(path.join(repoRoot, 'Dockerfile'), 'utf8');

        expect(dockerfile).toContain('COPY custom-modules/kiwibnc/ /app/src/');
        expect(dockerfile).toContain('/app/src/worker/messagestores/mariadb.js');
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
