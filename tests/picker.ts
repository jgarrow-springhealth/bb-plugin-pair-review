import { expect } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

// jsdom lacks the layout APIs Radix Select calls while it focuses options.
if (!Element.prototype.scrollIntoView)
  Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.hasPointerCapture)
  Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture)
  Element.prototype.releasePointerCapture = () => {};

/** Opens the styled dropdown named `label` and picks `option`, as a keyboard user would. */
export async function choose(label: string, option: string) {
  const trigger = screen.getByRole("combobox", { name: label });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const item = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(item, { key: "Enter" });
  await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
}

/** The text a styled dropdown currently shows. */
export const shown = (label: string) =>
  screen.getByRole("combobox", { name: label }).textContent;
