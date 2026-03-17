#!/usr/bin/env node

import { lstatSync, readlinkSync, realpathSync, unlinkSync, existsSync } from 'node:fs';
import path from 'node:path';

const pkgName = process.env.npm_package_name || 'clawpal-connect';
const prefix = process.env.npm_config_prefix?.trim();
const isGlobal = process.env.npm_config_global === 'true';

function safeUnlinkIfBrokenSymlink(targetPath) {
  try {
    const stat = lstatSync(targetPath);
    if (!stat.isSymbolicLink()) {
      return;
    }

    const linkTarget = readlinkSync(targetPath);
    const resolvedTarget = path.resolve(path.dirname(targetPath), linkTarget);
    const broken = !existsSync(resolvedTarget);

    if (!broken) {
      return;
    }

    unlinkSync(targetPath);
    console.log(`[preinstall] removed broken symlink: ${targetPath} -> ${linkTarget}`);
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'ENOENT') {
      return;
    }
    console.warn(`[preinstall] failed to inspect ${targetPath}: ${error}`);
  }
}

function main() {
  if (!isGlobal || !prefix) {
    return;
  }

  const nodeModulesTarget = path.join(prefix, 'lib', 'node_modules', pkgName);
  const binTarget = path.join(prefix, 'bin', pkgName);

  safeUnlinkIfBrokenSymlink(nodeModulesTarget);
  safeUnlinkIfBrokenSymlink(binTarget);

  // Also clean nested Homebrew-style symlink target if npm already resolved it oddly.
  try {
    const resolved = realpathSync.native(prefix);
    if (resolved !== prefix) {
      safeUnlinkIfBrokenSymlink(path.join(resolved, 'lib', 'node_modules', pkgName));
      safeUnlinkIfBrokenSymlink(path.join(resolved, 'bin', pkgName));
    }
  } catch {
    // ignore
  }
}

main();
