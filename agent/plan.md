# Plan

1. Modify `crawlCareerListings.ts`:
   - In `extractLinks`, strip `/application`, `/apply`, `/apply-now` from the end of URLs to point to JD rather than just application form.
   - Remove `"/application"` from `nonJobPatterns` in `looksLikeJobDetail` since it's now handled by stripping, or keep it to be safe. Actually, better to strip it so the stripped URL passes the check naturally.

2. Modify `extractJobDetail.ts`:
   - Remove `looksLikeJobPage` heuristic. Let the LLM read the text and decide if it's a valid job description.
   - Update `llmExtract` prompt to explicitly instruct the LLM to return `{"title": "NOT_A_JOB", ...}` if it doesn't see a proper job description with role, responsibilities, etc. This handles the user's desire: "these decisions should be taken by the LLM".
   - Allow LLM to extract up to ~1000 chars for the `description` instead of 400 chars, so it includes "The Role", "Key Responsibilities", "What you bring". The user specifically mentioned wanting these details.

3. Modify `scrapeXProfile.ts` or `findCareersPage.ts` for Gateway CTAs decision by LLM:
   - When searching for a careers page, if no direct match is found, enhance `findCareersUrlWithLLM`'s prompt to encourage selecting "View Open Roles" or "Explore Opportunities" CTAs.
   - "when the clicked link is not a career page or the listing are , we are aborting the search and process is ended (but surely if the page has buttons likes see open roles or view opportunities or any buttons to click on the career page,, we want to checkout the page too,,,, before we cancel the search,,,allow the LLM to take decision in this case)"
   - In `scrapeXProfile.ts`, where we use `findCareersUrlWithLLM`, I will update the prompt to explicitly say "Look for CTAs like 'open roles', 'view opportunities', 'join our team'."
