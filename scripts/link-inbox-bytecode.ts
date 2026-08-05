import type { Hex } from "viem";
import { getAddress } from "viem";

export type LinkReferences = Record<
  string,
  Record<string, Array<{ start: number; length: number }>>
>;

/**
 * Substitute Solidity library placeholders in creation bytecode.
 * `libraries` maps library name → address (e.g. `{ MpcAbiCodec: "0x...", InboxCallLib: "0x..." }`).
 */
export const linkBytecodeWithLibraries = (
  bytecode: Hex,
  linkReferences: LinkReferences,
  libraries: Record<string, `0x${string}`>
): Hex => {
  let hex = bytecode.startsWith("0x") ? bytecode.slice(2) : bytecode;

  for (const [name, address] of Object.entries(libraries)) {
    const addr = getAddress(address).slice(2).toLowerCase();
    if (addr.length !== 40) {
      throw new Error(`linkBytecodeWithLibraries: expected 20-byte address for ${name}`);
    }
    let linked = false;
    for (const sourceLibraries of Object.values(linkReferences)) {
      const refs = sourceLibraries[name];
      if (!refs?.length) continue;
      for (const { start, length } of refs) {
        if (length !== 20) {
          throw new Error(`linkBytecodeWithLibraries: unexpected placeholder length ${length}`);
        }
        const hexStart = start * 2;
        const hexLen = length * 2;
        hex = `${hex.slice(0, hexStart)}${addr}${hex.slice(hexStart + hexLen)}`;
        linked = true;
      }
    }
    if (!linked && hex.includes("_")) {
      // Library may already be absent from this artifact (idempotent).
    }
  }

  if (hex.includes("_")) {
    throw new Error(
      `linkBytecodeWithLibraries: bytecode still has placeholders; provided=${Object.keys(libraries).join(",")}`
    );
  }

  return (`0x${hex}`) as Hex;
};

/** @deprecated Prefer {linkBytecodeWithLibraries}. */
export const linkBytecodeWithLibrary = (
  bytecode: Hex,
  linkReferences: LinkReferences,
  libraryName: string,
  libraryAddress: `0x${string}`
): Hex => linkBytecodeWithLibraries(bytecode, linkReferences, { [libraryName]: libraryAddress });
