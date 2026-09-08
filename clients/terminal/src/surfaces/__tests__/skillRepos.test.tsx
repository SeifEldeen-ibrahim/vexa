/** Settings → GitHub: picking the repo each product writes to.
 *
 *  Both behaviours here were reported from the first real setup, and both are the kind a refactor
 *  loses quietly: saving a token left the picker below still saying "no GitHub token saved" with
 *  its dropdown disabled until a hard refresh, and the picker was a native select that a real
 *  GitHub account turns into an unusable list of a hundred names.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import { GitHubTokenCard, SkillReposCard } from "../tokens";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REPOS = [
  { name: "vibe-pipe", full_name: "seif/vibe-pipe", url: "https://github.com/seif/vibe-pipe.git",
    private: true, default_branch: "main", can_push: true },
  { name: "biamiDev", full_name: "seif/biamiDev", url: "https://github.com/seif/biamiDev.git",
    private: true, default_branch: "main", can_push: true },
  { name: "readonly-thing", full_name: "someorg/readonly-thing",
    url: "https://github.com/someorg/readonly-thing.git",
    private: false, default_branch: "main", can_push: false },
];

const SKILLS = [
  { id: "partic", label: "Partic", pin_hint: "the repo Partic syncs from", pinned: null },
  { id: "biami", label: "BIAMI", pin_hint: "your BIAMI Dev checkout", pinned: null },
];

/** A fetch that answers the two endpoints these cards use, and records what was posted. */
function stubFetch(opts: { tokenSet: boolean; repos?: typeof REPOS; posts?: unknown[] }) {
  const posts = opts.posts ?? [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (String(url).includes("/api/skills/repos")) {
      if (init?.method === "POST") { posts.push(body); return json({ skills: {} }); }
      return json({ skills: SKILLS, repos: opts.tokenSet ? (opts.repos ?? REPOS) : [],
                    note: opts.tokenSet ? "" : "no GitHub token saved", token_set: opts.tokenSet });
    }
    if (String(url).includes("/api/workspace/git-token")) {
      if (init?.method === "POST") { opts.tokenSet = Boolean(body?.token); return json({ set: opts.tokenSet, masked: "••••abcd" }); }
      return json({ set: opts.tokenSet, masked: opts.tokenSet ? "••••abcd" : null });
    }
    return json({});
  }));
  return posts;
}

const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data }) as unknown as Response;

describe("the repo picker is searchable", () => {
  it("filters by anything in owner/name, not just the start", async () => {
    // Type-ahead on a native <select> only matches from the start of the string, and nobody
    // remembers whether a repo is `vexa-vibe-pipe` or `vibe-pipe`.
    stubFetch({ tokenSet: true });
    render(<SkillReposCard />);
    await screen.findByText("Partic");

    fireEvent.click(screen.getAllByText(/Not set/)[0]);
    fireEvent.change(await screen.findByPlaceholderText("Search your repos…"), { target: { value: "biami" } });

    expect(screen.getByText("seif/biamiDev")).toBeTruthy();
    expect(screen.queryByText("seif/vibe-pipe")).toBeNull();
  });

  it("picks the repo you click, and posts its clone URL", async () => {
    const posts = stubFetch({ tokenSet: true });
    render(<SkillReposCard />);
    await screen.findByText("Partic");

    fireEvent.click(screen.getAllByText(/Not set/)[0]);
    fireEvent.click(await screen.findByText("seif/vibe-pipe"));

    await waitFor(() => expect(posts.length).toBe(1));
    expect(posts[0]).toMatchObject({ skill: "partic", repo: "https://github.com/seif/vibe-pipe.git" });
  });

  it("SHOWS a repo the token cannot push to, and refuses to pick it", async () => {
    // Hiding it would read as "that repo is gone", and the person would go looking for the repo
    // instead of at the token, which is where the problem is.
    const posts = stubFetch({ tokenSet: true });
    render(<SkillReposCard />);
    await screen.findByText("Partic");

    fireEvent.click(screen.getAllByText(/Not set/)[0]);
    const row = await screen.findByText("someorg/readonly-thing");
    expect(screen.getAllByText("read-only").length).toBeGreaterThan(0);

    fireEvent.click(row);
    await new Promise((r) => setTimeout(r, 20));
    expect(posts.length).toBe(0);
  });

  it("says so when nothing matches, rather than showing an empty box", async () => {
    stubFetch({ tokenSet: true });
    render(<SkillReposCard />);
    await screen.findByText("Partic");
    fireEvent.click(screen.getAllByText(/Not set/)[0]);
    fireEvent.change(await screen.findByPlaceholderText("Search your repos…"), { target: { value: "zzzz" } });
    expect(screen.getByText("No repo matches that.")).toBeTruthy();
  });
});

describe("saving a token updates the picker below it", () => {
  it("re-asks for the repo list when the token card reports a change", async () => {
    // The reported bug: the picker fetched once on mount, so after saving a token it kept saying
    // "no GitHub token saved" with its dropdown disabled until a hard refresh.
    const state = { tokenSet: false };
    stubFetch(state);

    function Section() {
      const [key, setKey] = React.useState(0);
      return (<>
        <GitHubTokenCard onTokenChange={() => setKey((k) => k + 1)} />
        <SkillReposCard reloadKey={key} />
      </>);
    }
    render(<Section />);
    expect(await screen.findByText("Save a GitHub token above to choose a repo.")).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/ghp_/), { target: { value: "ghp_realtoken" } });
    fireEvent.click(screen.getByText("Save token"));

    // …and without a reload, the picker is live.
    await waitFor(() =>
      expect(screen.queryByText("Save a GitHub token above to choose a repo.")).toBeNull());
    fireEvent.click(screen.getAllByText(/Not set/)[0]);
    expect(await screen.findByText("seif/vibe-pipe")).toBeTruthy();
  });
});
