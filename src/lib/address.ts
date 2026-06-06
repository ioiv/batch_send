export type AddressKind = "solana" | "evm";

const solanaAddressPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const base58Alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58Indexes = new Map([...base58Alphabet].map((character, index) => [character, index]));

function decodeBase58(value: string) {
  const bytes = [0];

  for (const character of value) {
    const alphabetIndex = base58Indexes.get(character);
    if (alphabetIndex === undefined) return null;

    let carry = alphabetIndex;
    for (let index = 0; index < bytes.length; index += 1) {
      carry += bytes[index] * 58;
      bytes[index] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  for (let index = 0; index < value.length - 1 && value[index] === "1"; index += 1) {
    bytes.push(0);
  }

  return Uint8Array.from(bytes.reverse());
}

export function isValidSolanaAddress(address: string) {
  if (!solanaAddressPattern.test(address)) return false;
  return decodeBase58(address)?.length === 32;
}

export function getListAddressKind(address: string): AddressKind | null {
  if (isValidSolanaAddress(address)) return "solana";
  if (evmAddressPattern.test(address)) return "evm";
  return null;
}

export function getDuplicateAddressKey(address: string, kind: AddressKind) {
  return kind === "evm" ? address.toLowerCase() : address;
}

export function shortenAddress(address: string) {
  return address.length > 12 ? `${address.slice(0, 4)}...${address.slice(-4)}` : address;
}
