from __future__ import annotations

import asyncio
import random
from typing import Any


async def probe_doubao_drag_captcha(page: Any) -> dict[str, Any]:
    probe: dict[str, Any] = {
        "source": "zhenxun-plugin-ai_creation-compatible",
        "container_present": False,
        "container_visible": False,
        "iframe_present": False,
        "prompt_visible": False,
        "prompt_text": "",
        "captcha_box_visible": False,
        "image_count": 0,
        "drag_area_visible": False,
        "submit_visible": False,
        "solver_compatible": False,
        "error": None,
    }
    try:
        container = page.locator("#captcha_container")
        probe["container_present"] = await container.count() > 0
        if probe["container_present"]:
            probe["container_visible"] = await container.first.is_visible()
            probe["iframe_present"] = await container.locator("iframe").count() > 0

        frame = page.frame_locator("#captcha_container iframe")
        prompt = frame.locator(".captcha-prompt-bar .tit")
        if await prompt.count() > 0:
            probe["prompt_visible"] = await prompt.first.is_visible()
            text = await prompt.first.text_content()
            probe["prompt_text"] = " ".join((text or "").split())

        captcha_box = frame.locator("#vc_captcha_box")
        if await captcha_box.count() > 0:
            probe["captcha_box_visible"] = await captcha_box.first.is_visible()

        images = frame.locator("#captcha_verify_image > div.img-container .canvas-container")
        probe["image_count"] = await images.count()

        drag_area = frame.locator("#captcha_verify_image > div.drag-area")
        if await drag_area.count() > 0:
            probe["drag_area_visible"] = await drag_area.first.is_visible()

        submit_button = frame.locator(".vc-captcha-verify-pc-button")
        if await submit_button.count() > 0:
            probe["submit_visible"] = await submit_button.first.is_visible()

        probe["solver_compatible"] = bool(
            probe["container_visible"]
            and probe["iframe_present"]
            and probe["prompt_visible"]
            and probe["captcha_box_visible"]
            and probe["image_count"]
            and probe["drag_area_visible"]
            and probe["submit_visible"]
        )
    except Exception as exc:
        probe["error"] = str(exc)
    return probe


def probe_has_visible_challenge(probe: dict[str, Any] | None) -> bool:
    if not isinstance(probe, dict):
        return False
    return bool(
        probe.get("solver_compatible")
        or probe.get("container_visible")
        or probe.get("captcha_box_visible")
        or probe.get("image_count")
        or probe.get("drag_area_visible")
        or probe.get("submit_visible")
    )


async def apply_doubao_drag_captcha_indices(page: Any, indices: list[int]) -> dict[str, Any]:
    result: dict[str, Any] = {
        "object": "doubao_drag_captcha_solution",
        "attempted_indices": list(indices),
        "dragged_indices": [],
        "submitted": False,
        "challenge_hidden": False,
        "error": None,
    }
    try:
        captcha_container = page.locator("#captcha_container")
        frame = page.frame_locator("#captcha_container iframe")
        image_elements = frame.locator("#captcha_verify_image > div.img-container .canvas-container")
        drag_area = frame.locator("#captcha_verify_image > div.drag-area")
        submit_button = frame.locator(".vc-captcha-verify-pc-button")
        count = await image_elements.count()
        target_box = await drag_area.bounding_box()
        if count <= 0 or not target_box:
            result["error"] = "Captcha image elements or drag target are not available."
            return result

        for raw_index in indices:
            try:
                index = int(raw_index)
            except (TypeError, ValueError):
                continue
            if index < 1 or index > count:
                continue
            source = image_elements.nth(index - 1)
            source_box = await source.bounding_box()
            if not source_box:
                continue

            start_x = source_box["x"] + source_box["width"] / 2 + random.uniform(-5, 5)
            start_y = source_box["y"] + source_box["height"] / 2 + random.uniform(-5, 5)
            end_x = target_box["x"] + target_box["width"] / 2 + random.uniform(-10, 10)
            end_y = target_box["y"] + target_box["height"] / 2 + random.uniform(-10, 10)

            await page.mouse.move(start_x, start_y, steps=random.randint(10, 20))
            await page.mouse.down()
            await asyncio.sleep(random.uniform(0.1, 0.3))
            await page.mouse.move(end_x, end_y, steps=random.randint(30, 60))
            await page.mouse.up()
            await asyncio.sleep(random.uniform(0.5, 1.0))
            result["dragged_indices"].append(index)

        if not result["dragged_indices"]:
            result["error"] = "No valid captcha indices were dragged."
            return result

        await submit_button.click()
        result["submitted"] = True
        for _ in range(20):
            if await captcha_container.count() <= 0 or not await captcha_container.first.is_visible():
                result["challenge_hidden"] = True
                break
            await asyncio.sleep(0.5)
    except Exception as exc:
        result["error"] = str(exc)
    return result
