from pathlib import Path
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
RESOURCES = ROOT / 'resources'
EXTENSION = ROOT / 'extension'
ICON_SIZES = (16, 24, 32, 48, 64, 128, 256)


def resized(source: Image.Image, size: tuple[int, int]) -> Image.Image:
    return source.resize(size, Image.Resampling.LANCZOS)


def compact_icon(source: Image.Image, size: int) -> Image.Image:
    """Give the detailed dragon a solid silhouette at taskbar/icon sizes."""
    canvas = Image.new('RGBA', (size, size))
    draw = ImageDraw.Draw(canvas)
    margin = max(0, round(size * 0.025))
    outline = max(1, round(size * 0.025))
    draw.ellipse(
        (margin, margin, size - 1 - margin, size - 1 - margin),
        fill='#310b05',
        outline='#fb6a0b',
        width=outline
    )

    # Small high-detail artwork loses apparent weight after OS downsampling.
    # A little contrast and sharpening keeps the face legible without changing
    # the full-size source used inside Draco itself.
    mark_size = round(size * 0.96)
    mark = resized(source, (mark_size, mark_size))
    mark = ImageEnhance.Contrast(mark).enhance(1.08)
    mark = mark.filter(ImageFilter.UnsharpMask(radius=max(0.4, size / 96), percent=120, threshold=2))
    offset = ((size - mark_size) // 2, (size - mark_size) // 2)
    canvas.alpha_composite(mark, offset)
    return canvas


app_icon = Image.open(RESOURCES / 'appIcon.png').convert('RGBA')
resized(app_icon, (512, 512)).save(RESOURCES / 'icon.png', optimize=True)
# Small display-sized copy for the splash window, which shows it at 34px and
# whose whole job is to appear quickly - the full 512px file decodes to
# several megabytes of RGBA for a mark a fraction of that size.
resized(app_icon, (128, 128)).save(RESOURCES / 'icon-splash.png', optimize=True)
compact_icon(app_icon, 256).save(
    RESOURCES / 'icon.ico',
    sizes=[(size, size) for size in ICON_SIZES]
)
compact_icon(app_icon, 256).save(EXTENSION / 'icon.png', optimize=True)

status_dir = EXTENSION / 'status-icons'
status_dir.mkdir(exist_ok=True)
for status, color in (('active', '#22c55e'), ('inactive', '#f59e0b')):
    for excluded in (False, True):
        state = f'{status}-excluded' if excluded else status
        for size in (16, 32, 48, 128):
            icon = compact_icon(app_icon, size)
            draw = ImageDraw.Draw(icon)
            radius = max(3, round(size * 0.18))
            inset = max(0, round(size * 0.015))
            center = (size - inset - radius, size - inset - radius)
            outline = max(1, round(size * 0.035))
            draw.ellipse(
                (
                    center[0] - radius,
                    center[1] - radius,
                    center[0] + radius,
                    center[1] + radius
                ),
                fill=color,
                outline='#111827',
                width=outline
            )
            if excluded:
                arm = max(3, round(size * 0.10))
                x = size - inset - arm
                y = inset + arm
                line = max(1, round(size * 0.04))
                draw.line((x - arm, y - arm, x + arm, y + arm), fill='#f8fafc', width=line)
                draw.line((x + arm, y - arm, x - arm, y + arm), fill='#f8fafc', width=line)
            icon.save(status_dir / f'{state}-{size}.png', optimize=True)

download = Image.open(RESOURCES / 'downloadButton.png').convert('RGBA')
button_width = 420
button_height = round(button_width * download.height / download.width)
resized(download, (button_width, button_height)).save(
    EXTENSION / 'downloadButton.png', optimize=True
)

print('Generated app, installer, extension, and download-button icons')
