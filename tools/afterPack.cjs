const { writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async ({ electronPlatformName, appOutDir }) => {
  if (electronPlatformName !== 'linux') return;
  const file = join(appOutDir, 'start-apogee.sh');
  writeFileSync(file, `#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec "$APP_DIR/apogee" "$@"
`, { mode: 0o755 });
  chmodSync(file, 0o755);
};
