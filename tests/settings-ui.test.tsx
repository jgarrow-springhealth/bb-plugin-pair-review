// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";
import { fireEvent, waitFor } from "@testing-library/react";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import { DEFAULT_PREFERENCES } from "../contract";

let slot: ReturnType<typeof renderSlot> | undefined;
afterEach(() => {
  slot?.lifecycle.unmount();
  slot = undefined;
  vi.restoreAllMocks();
});

test("contributes discoverable configuration help and a reset path", async () => {
  const app = await loadPluginApp(() => import("../app"));
  expect(app.experimentalSidebarFooterItems).toHaveLength(1);
  expect(app.experimentalSidebarFooterItems[0]).toMatchObject({
    kind: "action",
    label: "Pair Review settings",
  });

  const resetSettings = vi.fn(async () => DEFAULT_PREFERENCES);
  slot = renderSlot(
    app.settingsSections[0]!,
    {},
    { rpc: { resetSettings } },
  );

  expect(slot.getByText(/saved by BB/)).toBeTruthy();
  expect(slot.getByText(/original installed app/)).toBeTruthy();
  expect(slot.getByText(/does not store secret settings/)).toBeTruthy();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(slot.getByRole("button", { name: "Reset all to defaults" }));

  await waitFor(() => expect(resetSettings).toHaveBeenCalled());
  expect((await slot.findByRole("status")).textContent).toContain(
    "Defaults restored. Reopen Pair Review settings",
  );
});
