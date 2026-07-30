"""Generate the multi-resolution Windows icon used by ChatGPT2API Desktop."""

from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


CANVAS = 1024
ICON_SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def create_icon() -> Image.Image:
    image = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    mask = Image.new("L", (CANVAS, CANVAS), 0)
    ImageDraw.Draw(mask).rounded_rectangle((48, 48, 976, 976), radius=228, fill=255)

    gradient = Image.new("RGBA", (CANVAS, CANVAS))
    pixels = gradient.load()
    for y in range(CANVAS):
        progress = y / (CANVAS - 1)
        red = round(31 + (92 - 31) * progress)
        green = round(87 + (46 - 87) * progress)
        blue = round(214 + (190 - 214) * progress)
        for x in range(CANVAS):
            pixels[x, y] = (red, green, blue, 255)
    image.paste(gradient, (0, 0), mask)

    draw = ImageDraw.Draw(image)
    glow = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((104, 78, 700, 674), fill=(111, 210, 255, 46))
    glow_draw.ellipse((412, 510, 1010, 1108), fill=(142, 80, 255, 52))
    image.alpha_composite(glow)

    line_color = (231, 243, 255, 255)
    line_width = 54
    central = (512, 524)
    nodes = ((512, 274), (294, 650), (730, 650))
    for node in nodes:
        draw.line((central, node), fill=line_color, width=line_width, joint="curve")

    for x, y in nodes:
        draw.ellipse((x - 84, y - 84, x + 84, y + 84), fill=(239, 248, 255, 255))
        draw.ellipse((x - 43, y - 43, x + 43, y + 43), fill=(37, 95, 211, 255))

    draw.ellipse((central[0] - 126, central[1] - 126, central[0] + 126, central[1] + 126), fill=(255, 255, 255, 255))
    draw.ellipse((central[0] - 72, central[1] - 72, central[0] + 72, central[1] + 72), fill=(44, 77, 190, 255))
    draw.ellipse((central[0] - 28, central[1] - 28, central[0] + 28, central[1] + 28), fill=(126, 222, 255, 255))

    sparkle = (778, 254)
    draw.polygon(
        (
            (sparkle[0], sparkle[1] - 94),
            (sparkle[0] + 28, sparkle[1] - 28),
            (sparkle[0] + 94, sparkle[1]),
            (sparkle[0] + 28, sparkle[1] + 28),
            (sparkle[0], sparkle[1] + 94),
            (sparkle[0] - 28, sparkle[1] + 28),
            (sparkle[0] - 94, sparkle[1]),
            (sparkle[0] - 28, sparkle[1] - 28),
        ),
        fill=(255, 204, 87, 255),
    )
    return image


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", type=Path)
    arguments = parser.parse_args()

    icon = create_icon()
    output = Path(__file__).with_name("ChatGPT2API-Desktop.ico")
    icon.save(output, format="ICO", sizes=[(size, size) for size in ICON_SIZES])
    if arguments.preview:
        arguments.preview.parent.mkdir(parents=True, exist_ok=True)
        icon.save(arguments.preview, format="PNG")


if __name__ == "__main__":
    main()
