const { writeFileSync, chmodSync } = require('node:fs');
const { join } = require('node:path');

module.exports = async ({ electronPlatformName, appOutDir }) => {
  if (electronPlatformName !== 'linux') return;
  const file = join(appOutDir, 'start-apogee.sh');
  writeFileSync(file, `#!/bin/sh
set -eu
# Desktop entries and ~/.local/bin often point to the launcher through a symlink.
SCRIPT=$(readlink -f -- "$0")
APP_DIR=$(dirname -- "$SCRIPT")
exec "$APP_DIR/apogee" "$@"
`, { mode: 0o755 });
  chmodSync(file, 0o755);
};
