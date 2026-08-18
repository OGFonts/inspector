"""Build OGFonts Inspector PNG icons from the master artwork + a crisp 16px mark."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent
ICONS = ROOT.parent / "icons"
MASTER = ROOT / "og-master.png"
FONT = Path(r"C:\Windows\Fonts\segoeuib.ttf")
BG = (20, 21, 26, 255)
ACCENT = (214, 255, 63, 255)


def draw_toolbar_16():
    scale = 16
    s = 16 * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    pad = int(s * 0.04)
    radius = int(s * 0.22)
    draw.rounded_rectangle([pad, pad, s - pad - 1, s - pad - 1], radius=radius, fill=BG)
    font = ImageFont.truetype(str(FONT), int(s * 0.52))
    text = "Og"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (s - tw) / 2 - bbox[0]
    y = (s - th) / 2 - bbox[1] - int(s * 0.02)
    draw.text((x, y), text, font=font, fill=ACCENT)
    return img.resize((16, 16), Image.Resampling.LANCZOS)


def main():
    ICONS.mkdir(parents=True, exist_ok=True)
    master = Image.open(MASTER).convert("RGBA")
    for size in (32, 48, 128):
        master.resize((size, size), Image.Resampling.LANCZOS).save(ICONS / f"{size}.png", optimize=True)
    draw_toolbar_16().save(ICONS / "16.png", optimize=True)
    print("wrote 16, 32, 48, 128")


if __name__ == "__main__":
    main()
