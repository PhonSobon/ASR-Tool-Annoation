"""Khmer text normalization for training data."""
KHMER_DIGITS = str.maketrans("០១២៣៤៥៦៧៨៩", "0123456789")


def segment_text(text):
    """Khmer word segmentation with khmercut (words joined by single spaces); unchanged if not installed."""
    try:
        from khmercut import tokenize
    except ImportError:
        return text
    return " ".join(t for t in tokenize(text) if t.strip()) if text.strip() else ""


def normalize_text(text):
    """No zero-width spaces, Khmer digits -> 0-9, word-segmented, single spaces."""
    text = text.replace("​", " ").translate(KHMER_DIGITS)
    return " ".join(segment_text(text).split())
