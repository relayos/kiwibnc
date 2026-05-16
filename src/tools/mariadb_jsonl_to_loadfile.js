#!/usr/bin/env node

const fs = require('fs');
const readline = require('readline');
const { once } = require('events');

const TYPE_MAP = {
    PRIVMSG: 1,
    NOTICE: 2,
};

const DEFAULT_BUFFER_NORMALIZE = 'none';

async function main() {
    const args = parseArgs(process.argv.slice(2));

    const normalizeMode = validateNormalize(args.bufferNormalize || DEFAULT_BUFFER_NORMALIZE);
    const inputStream = args.input && args.input !== '-'
        ? fs.createReadStream(args.input)
        : process.stdin;
    const outputStream = args.output ? fs.createWriteStream(args.output) : process.stdout;

    const rl = readline.createInterface({
        input: inputStream,
        crlfDelay: Infinity,
    });

    let total = 0;
    let written = 0;
    let skipped = 0;
    const progressEvery = args.progress;

    try {
        for await (const line of rl) {
            if (!line.trim()) {
                continue;
            }
            total++;
            try {
                const record = JSON.parse(line);
                const row = recordToLoadRow(record, normalizeMode);
                if (!row) {
                    skipped++;
                    continue;
                }

                if (!outputStream.write(row + '\n')) {
                    await once(outputStream, 'drain');
                }
                written++;
            } catch (err) {
                skipped++;
                if (args.verbose) {
                    console.error(`Skipping line ${total}: ${err.message}`);
                }
            }

            if (progressEvery > 0 && total % progressEvery === 0) {
                console.error(`Processed ${total} lines (${written} written, ${skipped} skipped)`);
            }
        }
    } finally {
        if (outputStream !== process.stdout) {
            outputStream.end();
            await once(outputStream, 'finish');
        }
    }

    console.error(`Done. Lines read: ${total}. Written: ${written}. Skipped: ${skipped}.`);
}

function parseArgs(argv) {
    const args = {
        bufferNormalize: DEFAULT_BUFFER_NORMALIZE,
        verbose: false,
        progress: 100000,
        input: '-',
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-i' || arg === '--input') {
            args.input = argv[++i];
        } else if (arg === '-o' || arg === '--output') {
            args.output = argv[++i];
        } else if (arg === '-n' || arg === '--buffer-normalize') {
            args.bufferNormalize = argv[++i];
        } else if (arg === '-p' || arg === '--progress') {
            args.progress = parseInt(argv[++i], 10);
        } else if (arg === '-v' || arg === '--verbose') {
            args.verbose = true;
        } else if (arg === '-h' || arg === '--help') {
            printUsage();
            process.exit(0);
        }
    }

    return args;
}

function validateNormalize(mode) {
    if (mode !== 'none' && mode !== 'lower' && mode !== 'alnum') {
        throw new Error(`Invalid buffer normalize mode: ${mode}`);
    }
    return mode;
}

function recordToLoadRow(record, normalizeMode) {
    const type = TYPE_MAP[String(record.type || '').toUpperCase()];
    if (!type) {
        return null;
    }

    const buffer = stringVal(record.buffer);
    const fields = [
        intVal(record.user_id),
        intVal(record.network_id),
        buffer,
        normalizeBuffer(buffer, normalizeMode),
        intVal(record.time),
        type,
        stringVal(record.msgid),
        formatTags(record.msgtags),
        stringVal(record.prefix),
        formatParams(record.params),
        stringVal(record.data),
    ];

    return fields.map(escapeField).join('\t');
}

function normalizeBuffer(buffer, mode) {
    if (!buffer) {
        return buffer;
    }
    if (mode === 'lower') {
        return buffer.toLowerCase();
    }
    if (mode === 'alnum') {
        return buffer.toLowerCase().replace(/[^a-z0-9#]/g, '');
    }
    return buffer;
}

function formatTags(tags) {
    if (tags === null || tags === undefined) {
        return '{}';
    }
    if (typeof tags === 'string') {
        return tags;
    }
    try {
        return JSON.stringify(tags);
    } catch (err) {
        return '{}';
    }
}

function formatParams(params) {
    if (Array.isArray(params)) {
        return params.join(' ');
    }
    if (params === null || params === undefined) {
        return '';
    }
    return String(params);
}

function intVal(value) {
    const n = parseInt(value, 10);
    if (Number.isFinite(n)) {
        return n;
    }
    return 0;
}

function stringVal(value) {
    if (value === null || value === undefined) {
        return '';
    }
    return String(value);
}

function escapeField(value) {
    if (value === null || value === undefined) {
        return '\\N';
    }
    return String(value)
        .replace(/\\/g, '\\\\')
        .replace(/\t/g, '\\t')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\0/g, '\\0');
}

function printUsage() {
    console.log('Convert message JSONL to a LOAD DATA INFILE ready TSV file.');
    console.log('Usage: node src/tools/mariadb_jsonl_to_loadfile.js [--input messages.jsonl] [--output messages.tsv] [--buffer-normalize lower|alnum|none]');
    console.log('Options:');
    console.log('  -i, --input               Path to input JSONL file ("-" or omit for stdin)');
    console.log('  -o, --output              Path to output TSV file (default: stdout)');
    console.log('  -n, --buffer-normalize    Match message_store_mariadb.buffer_normalize (default: none)');
    console.log('  -p, --progress            Log progress every N lines (default: 100000, 0 to disable)');
    console.log('  -v, --verbose             Print parse errors');
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
