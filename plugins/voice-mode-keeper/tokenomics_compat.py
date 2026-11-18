"""Normalize an unknown Tokenomics window size to JSON null."""
import re


class AnchorMismatch(RuntimeError):
    pass


SIZE_TOKENS = re.compile(
    rb'(?m)^(?P<indent>[ \t]*)sizeTokens[ \t]*:[ \t]*sizeOf\([ \t]*\r?\n'
    rb'(?:[^\n]*\n){1,20}?^(?P=indent)\)(?P<fallback>[ \t]*\?\?[ \t]*null)?(?=[ \t]*,)'
)


def rewrite(source: bytes, _version: str) -> bytes:
    matches = list(SIZE_TOKENS.finditer(source))
    if len(matches) != 1:
        raise AnchorMismatch(f'Ожидался один якорь sizeTokens, найдено: {len(matches)}.')
    anchor = matches[0]
    if anchor.group('fallback'):
        return source
    offset = anchor.end()
    return source[:offset] + b' ?? null' + source[offset:]
