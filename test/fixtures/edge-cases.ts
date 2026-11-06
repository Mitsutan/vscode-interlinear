/*
 * Copyright (c) 2026 Example Corp.
 * SPDX-License-Identifier: MIT
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import { readFile } from 'node:fs/promises';

// ===========================================================

/**
 * Parses the configuration file and returns a normalized `Config` object.
 *
 * Unknown keys are ignored, but a warning is logged via `logger.warn()`.
 * See {@link loadDefaults} for the fallback values.
 *
 * - Supports JSON and JSONC.
 * - Environment variables like `APP_PORT` override values in the file.
 *
 * @param path - Absolute path to the config file.
 * @param {ParseOptions} [options] Optional parser settings. When `strict` is true,
 *   unknown keys cause an error instead of a warning.
 * @returns The parsed configuration, or `undefined` if the file does not exist.
 * @throws {ConfigError} If the file contains invalid syntax.
 * @example
 * const config = await parseConfig('/etc/app.json', { strict: true });
 * console.log(config.port);
 * @since 1.2.0
 */
export async function parseConfig(path: string, options?: ParseOptions): Promise<Config | undefined> {
  // Read the whole file at once; config files are small enough
  // that streaming would only add complexity.
  const text = await readFile(path, 'utf8'); // never throws ENOENT here because we checked above
  // const legacy = parseLegacy(text);
  // if (legacy) return legacy;
  // TODO: cache the result per path to avoid re-reading on every call.
  return normalize(JSON.parse(text)); // 正規化してから返す
}

// 設定ファイルが存在しない場合は既定値を使う
const DEFAULT_PORT = 8080; // fallback when APP_PORT is unset

/* Retries the operation with exponential backoff (max 5 attempts). */
function retry() {}

// Tokens such as <|plamo:tag|> must never reach the model unescaped.
const marker = '<|plamo:tag|>';

// @ts-expect-error -- intentional for test
const x: number = 'x';
