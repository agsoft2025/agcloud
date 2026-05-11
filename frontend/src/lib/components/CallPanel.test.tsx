import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import CallPanel from "./CallPanel";

describe("CallPanel", () => {
  it("renders the disconnected fallback state", () => {
    render(<CallPanel roomName="" participantCount={0} />);

    expect(screen.getByRole("heading", { name: /call panel/i })).toBeInTheDocument();
    expect(screen.getByText(/room: not connected/i)).toBeInTheDocument();
    expect(screen.getByText(/participants: 0/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /leave call/i })).toBeDisabled();
  });
});
