/**
 * WEBIRC extension for KiwiBNC
 *
 * Sends WEBIRC command to upstream IRC servers to pass through the client's real IP address.
 * This allows IRC operators to see the actual client IP for banning purposes.
 *
 * Configuration in config.ini:
 *
 * [webirc]
 * # Gateway name sent in WEBIRC command (defaults to "kiwibnc")
 * gateway_name = "kiwibnc"
 *
 * # Default WEBIRC password for all upstreams (optional)
 * password = "your_webirc_password"
 *
 * # Per-host WEBIRC passwords (optional, overrides default)
 * # Format: { "irc.example.com" = "password1", "*.libera.chat" = "password2" }
 * passwords = {}
 */

const { hasMinimatch } = require('../../libs/helpers');

module.exports.init = async function init(hooks, app) {
    hooks.on('connection_open', async event => {
        const upstream = event.upstream;
        if (!upstream) {
            return;
        }

        const webircConf = app.conf.get('webirc', {});
        const gatewayName = webircConf.gateway_name || 'kiwibnc';

        // Find WEBIRC password for this host
        const upstreamHost = upstream.state.host || '';
        let password = findPassword(upstreamHost, webircConf);

        if (!password) {
            l.debug(`[webirc] No WEBIRC password configured for ${upstreamHost}`);
            return;
        }

        // Get client IP from attached clients
        let clientIp = null;
        let clientHostname = null;

        upstream.forEachClient(client => {
            if (!clientIp && client.state.host) {
                clientIp = client.state.host;
                // Use IP as hostname unless we have reverse DNS (not implemented)
                clientHostname = clientIp;
            }
        });

        // If no clients attached, check if we stored the IP when connection was initiated
        if (!clientIp) {
            clientIp = await upstream.state.tempGet('webirc_client_ip');
            clientHostname = clientIp;
        }

        if (!clientIp) {
            l.debug(`[webirc] No client IP available for ${upstreamHost}`);
            return;
        }

        // Build WEBIRC command
        // Format: WEBIRC <password> <gateway> <hostname> <ip> [:<flags>]
        const webircLine = `WEBIRC ${password} ${gatewayName} ${clientHostname} ${clientIp}`;

        l.info(`[webirc] Sending WEBIRC for ${upstreamHost} with client IP ${clientIp}`);
        upstream.writeLine(webircLine);
    });

    // Store client IP when they initiate a network connection
    // This ensures we have the IP even if the client disconnects before upstream connects
    hooks.on('connection_to_open', async event => {
        const upstream = event.upstream;
        if (!upstream) {
            return;
        }

        let clientIp = null;
        upstream.forEachClient(client => {
            if (!clientIp && client.state.host) {
                clientIp = client.state.host;
            }
        });

        if (clientIp) {
            await upstream.state.tempSet('webirc_client_ip', clientIp);
        }
    });
};

/**
 * Find WEBIRC password for a given host
 * Checks per-host passwords first (with glob matching), then falls back to default
 */
function findPassword(host, webircConf) {
    const passwords = webircConf.passwords || {};
    const lcHost = host.toLowerCase();

    // Check exact match first
    if (passwords[lcHost]) {
        return passwords[lcHost];
    }

    // Check glob patterns using the helper
    for (const pattern in passwords) {
        if (hasMinimatch([pattern.toLowerCase()], lcHost)) {
            return passwords[pattern];
        }
    }

    // Fall back to default password
    return webircConf.password || null;
}
