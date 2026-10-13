const fs = require('fs');
const { execFileSync } = require('child_process');

const lines = fs.readFileSync('str.txt', 'utf8').split(/\r?\n/);

for (const line of lines) {
    if (!line.trim()) continue;

    try {
        const output = execFileSync(
            process.execPath,
            ['index.js', '-d', line],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );

        process.stdout.write(output);
    } catch (err) {
        process.stderr.write(`Failed for "${line}": ${err.message}\n`);
    }
}