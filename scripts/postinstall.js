#!/usr/bin/env node

import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const prefix = process.env.npm_config_prefix?.trim();
const packageJsonPath = process.env.npm_package_json?.trim();
const packageName = process.env.npm_package_name || 'clawpal-connect';

function log(message) {
  console.log(`[postinstall] ${message}`);
}

function copyIfExists(source, dest) {
  if (!existsSync(source)) {
    return;
  }
  cpSync(source, dest, { recursive: true });
}

function main() {
  if (!prefix || !packageJsonPath) {
    log('skip: missing npm prefix or package path');
    return;
  }

  const packageDir = path.dirname(packageJsonPath);
  const sourceDist = path.join(packageDir, 'dist');
  const sourceNodeModules = path.join(packageDir, 'node_modules');
  const sourcePackageJson = path.join(packageDir, 'package.json');

  if (!existsSync(sourceDist) || !existsSync(sourcePackageJson)) {
    log(`skip: package payload incomplete at ${packageDir}`);
    return;
  }

  const stableRoot = path.join(prefix, 'lib', `${packageName}-standalone`);
  const stableDist = path.join(stableRoot, 'dist');
  const stableNodeModules = path.join(stableRoot, 'node_modules');
  const stablePackageJson = path.join(stableRoot, 'package.json');
  const binPath = path.join(prefix, 'bin', packageName);
  const cliTarget = path.join(stableDist, 'cli.js');

  mkdirSync(path.join(prefix, 'lib'), { recursive: true });
  mkdirSync(path.join(prefix, 'bin'), { recursive: true });

  rmSync(stableRoot, { recursive: true, force: true });
  mkdirSync(stableRoot, { recursive: true });

  copyIfExists(sourceDist, stableDist);
  copyIfExists(sourceNodeModules, stableNodeModules);
  cpSync(sourcePackageJson, stablePackageJson);

  rmSync(binPath, { force: true });

  try {
    symlinkSync(cliTarget, binPath);
  } catch {
    writeFileSync(
      binPath,
      `#!/bin/sh\nexec node "${cliTarget}" "$@"\n`,
      'utf8',
    );
    chmodSync(binPath, 0o755);
  }

  log(`installed stable CLI at ${binPath}`);
}

main();
