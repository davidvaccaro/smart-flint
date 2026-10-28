import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const selected = process.argv.slice(2);
if (selected.some(value => !['--swift', '--android'].includes(value))) throw new Error('Usage: node scripts/check-native.mjs [--swift] [--android] (default: both required)');
const checks = selected.length ? selected : ['--swift', '--android'];
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) throw new Error(`${command} failed.\n${result.stderr || ''}\n${result.stdout || result.error?.message || ''}`);
  return result.stdout.trim();
}
const scratch = await mkdtemp(join(tmpdir(), 'smart-flint-native-check-'));
try {
  if (checks.includes('--swift')) {
    if (process.platform !== 'darwin') throw new Error('Swift platform verification requires macOS with Xcode iOS Simulator SDKs.');
    const sources = resolve(root, 'examples/native/swift/Sources/SMARTFlintNativeExample');
    const paths = (await readdir(sources)).filter(name => name.endsWith('.swift')).map(name => join(sources, name));
    run('swift', ['test', '--package-path', resolve(root, 'examples/native/swift'), '--scratch-path', join(scratch, 'swift-build')]);
    const sdk = run('xcrun', ['--sdk', 'iphonesimulator', '--show-sdk-path']);
    const target = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-ios15.0-simulator`;
    run('xcrun', ['swiftc', '-sdk', sdk, '-target', target, '-parse-as-library', '-module-name', 'SMARTFlintNativeExample', '-emit-module', '-emit-module-path', join(scratch, 'SMARTFlintNativeExample.swiftmodule'), ...paths]);
    run('xcrun', ['swiftc', '-typecheck', '-sdk', sdk, '-target', target, '-parse-as-library', '-I', scratch, resolve(root, 'examples/native/ios-app/AppDelegate.swift')]);
    process.stdout.write('Native Apple checks passed: three synthetic PKCE/callback/expiry/EHR-ticket transaction tests, macOS Swift package, iOS Simulator adapter, system-browser controller and UIKit launch sample.\n');
  }
  if (checks.includes('--android')) {
    const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || join(homedir(), 'Library/Android/sdk');
    let compiler = process.env.KOTLINC || (process.env.KOTLIN_HOME ? join(process.env.KOTLIN_HOME, 'bin/kotlinc') : 'kotlinc');
    if (process.platform === 'darwin' && !process.env.KOTLINC && !process.env.KOTLIN_HOME && existsSync('/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc')) compiler = '/Applications/Android Studio.app/Contents/plugins/Kotlin/kotlinc/bin/kotlinc';
    const platforms = join(sdk, 'platforms');
    const installed = (await readdir(platforms)).filter(name => name.startsWith('android-') && existsSync(join(platforms, name, 'android.jar'))).sort((a, b) => parseInt(b.slice(8)) - parseInt(a.slice(8)));
    if (!installed[0]) throw new Error('Install an Android SDK platform and set ANDROID_HOME.');
    run(compiler, ['-jvm-target', '1.8', '-classpath', join(platforms, installed[0], 'android.jar'), '-d', join(scratch, 'native-android.jar'), resolve(root, 'examples/native/android/SMARTFlintClient.kt'), resolve(root, 'examples/native/android/SMARTFlintLaunchActivity.kt')]);
    process.stdout.write(`Native Android source check passed: Kotlin API adapter and system-browser Activity compiled against ${installed[0]}.\n`);
  }
  process.stdout.write('Compilation checks do not exercise browser UI, app-link ownership, device lifecycle, or vendor authorization; those remain device/integration acceptance steps.\n');
} finally { await rm(scratch, { recursive: true, force: true }); }
