import * as fs from "node:fs";
import * as path from "node:path";
import { normalizePath } from "./eol";

export interface PathSafetyResult {
	safe: boolean;
	resolvedPath?: string;
	relativePath?: string;
	error?: string;
}

/**
 * Validates and safely resolves a file path against a workspace root directory.
 * Prevents traversal escapes (..), drive escapes on Windows, and symlink escapes outside the root.
 */
export function resolveSafePath(root: string, targetPath: string): PathSafetyResult {
	if (!root) {
		return { safe: false, error: "Root directory must not be empty" };
	}
	if (typeof targetPath !== "string") {
		return { safe: false, error: "Target path must be a string" };
	}

	const normalizedRoot = path.resolve(root);
	const normalizedTarget = normalizePath(targetPath);

	// Empty string or '.' represents the workspace root itself
	if (normalizedTarget === "" || normalizedTarget === ".") {
		return {
			safe: true,
			resolvedPath: normalizedRoot,
			relativePath: "",
		};
	}

	// Reject paths with obvious suspicious segments before resolution
	const segments = normalizedTarget.split("/");
	if (segments.some((seg) => seg === "..")) {
		// Test if resolving actually escapes root
		const tentativeResolved = path.resolve(normalizedRoot, normalizedTarget);
		const rel = path.relative(normalizedRoot, tentativeResolved);
		if (rel.startsWith("..") || path.isAbsolute(rel)) {
			return { safe: false, error: `Path traversal detected: "${targetPath}" attempts to escape root` };
		}
	}

	const absoluteTarget = path.isAbsolute(targetPath)
		? path.resolve(targetPath)
		: path.resolve(normalizedRoot, targetPath);

	// Case-insensitive check on Windows, case-sensitive on POSIX
	const relative = path.relative(normalizedRoot, absoluteTarget);
	const escapesRoot = relative.startsWith("..") || path.isAbsolute(relative);

	if (escapesRoot) {
		return { safe: false, error: `Path "${targetPath}" resolves outside root directory "${root}"` };
	}

	// Verify symlinks if the path or parent exists
	try {
		if (fs.existsSync(absoluteTarget)) {
			const realTargetPath = fs.realpathSync(absoluteTarget);
			const realRelative = path.relative(normalizedRoot, realTargetPath);
			if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) {
				// Also check if realpath of root matches
				const realRoot = fs.realpathSync(normalizedRoot);
				const realRelativeAgainstRealRoot = path.relative(realRoot, realTargetPath);
				if (
					realRelativeAgainstRealRoot.startsWith("..") ||
					path.isAbsolute(realRelativeAgainstRealRoot)
				) {
					return {
						safe: false,
						error: `Symlink target "${realTargetPath}" escapes root directory "${root}"`,
					};
				}
			}
		} else {
			// Find closest existing ancestor directory and verify its realpath
			let current = path.dirname(absoluteTarget);
			while (current && current !== path.dirname(current)) {
				if (fs.existsSync(current)) {
					const realCurrent = fs.realpathSync(current);
					const realRoot = fs.existsSync(normalizedRoot)
						? fs.realpathSync(normalizedRoot)
						: normalizedRoot;
					const relAgainstRoot = path.relative(realRoot, realCurrent);
					if (relAgainstRoot.startsWith("..") || path.isAbsolute(relAgainstRoot)) {
						return {
							safe: false,
							error: `Ancestor directory "${current}" resolves outside root directory`,
						};
					}
					break;
				}
				current = path.dirname(current);
			}
		}
	} catch (err: any) {
		return { safe: false, error: `Failed to resolve safe path: ${err.message}` };
	}

	const normalizedRelative = normalizePath(relative);
	return {
		safe: true,
		resolvedPath: absoluteTarget,
		relativePath: normalizedRelative,
	};
}
