# Aldora Quote Trends

Quote volume by branch, rep, product and customer, from the weekly Open Quotes and Closed Quotes exports.

- `/` dashboard (team access code)
- `/upload.html` weekly upload (manager code)

## One-time setup
1. In Netlify: Add new site > Import an existing project > GitHub > `aldora-quote-trends`. Leave build settings as they are and deploy.
2. Site configuration > Environment variables: add `TEAM_CODE` (for reps and managers) and `MANAGER_CODE` (for uploads).
3. Deploys > Trigger deploy > Deploy site, so the codes take effect.

## Weekly
1. Run Open Quotes (01/01/2026 or 12 months back, through today) and Closed Quotes. Save as Excel. Once, also upload an Open Quotes run from 01/01/2025 so the customer chart can compare each month with the same month last year. Uploads are kept for 25 months.
2. Open `/upload.html`, enter the manager code, drop both files, check the summary, click Save and publish.

## How the data works
- Files are read in the browser and merged with earlier uploads. A quote keeps the details from the newest file it appears in. Quotes that close later keep the details from when they were open.
- Closed quotes that never appeared in an open export are counted by branch and month only (the closed export has no customer, rep or products).
- Data is stored in Netlify Blobs (store `quote-trends`, key `dataset.json.gz`). The previous version is kept as `dataset-prev.json.gz`.
- No customer data is stored in this repo.
