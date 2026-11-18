"""Apply our compatibility change to a locally installed Tokenomics release."""
import hashlib
import json
from pathlib import Path
import re

RECIPE = Path(__file__).resolve().parents[1] / 'plugins/tokenomics-compat/upstream.json'
NULL_FALLBACK = b' ?? null'
SIZE_TOKENS = re.compile(
    rb'(?m)^(?P<indent>[ \t]*)sizeTokens[ \t]*:[ \t]*sizeOf\([ \t]*\n'
    rb'(?:[^\n]*\n){1,12}?^(?P=indent)\)(?P<fallback>[ \t]*\?\?[ \t]*null)?(?=[ \t]*,)'
)


def rewrite(source: bytes, version: str) -> bytes:
    recipe = json.loads(RECIPE.read_text(encoding='utf-8'))
    normalized = source.replace(b'\r\n', b'\n')
    matches = list(SIZE_TOKENS.finditer(normalized))
    if len(matches) != 1:
        raise RuntimeError(f'Tokenomics source changed: expected one sizeTokens anchor, found {len(matches)}')
    anchor = matches[0]
    if anchor.group('fallback'):
        return source

    checksum = hashlib.sha256(normalized).hexdigest()
    if version != recipe['version'] or checksum != recipe['originalSha256']:
        raise RuntimeError('Tokenomics upstream changed; review the catalog release before making the compatibility edit')

    offset = anchor.end()
    fixed = normalized[:offset] + NULL_FALLBACK + normalized[offset:]
    if hashlib.sha256(fixed).hexdigest() != recipe['patchedSha256']:
        raise RuntimeError('Tokenomics compatibility result checksum mismatch')
    if b'\r\n' in source:
        if source.count(b'\r\n') != normalized.count(b'\n'):
            raise RuntimeError('Tokenomics source has mixed line endings')
        return fixed.replace(b'\n', b'\r\n')
    return fixed
