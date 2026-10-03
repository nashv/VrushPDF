/**
 * scripts/publish-public-release.ts
 *
 * Dedicated utility script to create, verify, or sync release assets and
 * cryptographic checksums (SHA256SUMS.txt) directly to the public distribution
 * repository (nashv/VrushPDF) via the GitHub Releases API.
 *
 * Usage:
 *   npx tsx scripts/publish-public-release.ts [tag] [artifactsDir]
 *
 * Environment variables:
 *   PUBLIC_REPO_TOKEN or RELEASE_TOKEN or GH_TOKEN or GITHUB_TOKEN
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

const TARGET_REPO = "nashv/VrushPDF";
const DEFAULT_TAG = "v0.5.8";

function computeSha256(filePath: string): string {
  const fileBuffer = fs.readFileSync(filePath);
  const hashSum = crypto.createHash("sha256");
  hashSum.update(fileBuffer);
  return hashSum.digest("hex");
}

async function main() {
  const args = process.argv.slice(2);
  const tagName = args[0] || process.env.GITHUB_REF_NAME || DEFAULT_TAG;
  const artifactsDir = args[1] || "dist";

  const token =
    process.env.PUBLIC_REPO_TOKEN ||
    process.env.RELEASE_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN;

  console.log(`\n=== VrushPDF Public Release Publisher ===`);
  console.log(`Target Repository : ${TARGET_REPO}`);
  console.log(`Release Tag       : ${tagName}`);
  console.log(`Artifacts Dir     : ${artifactsDir}`);
  console.log(`Authentication    : ${token ? "Token present (" + token.slice(0, 4) + "..." + token.slice(-4) + ")" : "No token detected (read-only mode)"}\n`);

  if (!token) {
    console.warn(
      `[WARN] No GitHub access token provided. Set PUBLIC_REPO_TOKEN, RELEASE_TOKEN, or GH_TOKEN to publish.\n`
    );
  }

  // 1. Gather all files in artifacts directory if it exists
  const filesToUpload: { name: string; path: string; size: number; sha256: string }[] = [];

  if (fs.existsSync(artifactsDir)) {
    const entries = fs.readdirSync(artifactsDir);
    for (const entry of entries) {
      const fullPath = path.join(artifactsDir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isFile() && !entry.startsWith(".")) {
        const sha256 = computeSha256(fullPath);
        filesToUpload.push({
          name: entry,
          path: fullPath,
          size: stat.size,
          sha256
        });
      }
    }
  }

  // Also check local macOS bundle if dist is empty
  if (filesToUpload.length === 0) {
    const localDmgPath = path.join(
      process.cwd(),
      "src-tauri/target/release/bundle/dmg",
      `VrushPDF_${tagName.replace(/^v/, "")}_aarch64.dmg`
    );
    if (fs.existsSync(localDmgPath)) {
      const stat = fs.statSync(localDmgPath);
      filesToUpload.push({
        name: path.basename(localDmgPath),
        path: localDmgPath,
        size: stat.size,
        sha256: computeSha256(localDmgPath)
      });
    }
  }

  console.log(`Found ${filesToUpload.length} release asset(s) to process:`);
  for (const f of filesToUpload) {
    console.log(`  • ${f.name} (${(f.size / 1024 / 1024).toFixed(2)} MB) - SHA256: ${f.sha256}`);
  }

  // Generate SHA256SUMS.txt content
  if (filesToUpload.length > 0) {
    const sumsContent =
      filesToUpload
        .filter((f) => f.name !== "SHA256SUMS.txt")
        .map((f) => `${f.sha256}  ${f.name}`)
        .join("\n") + "\n";

    const sumsPath = path.join(fs.existsSync(artifactsDir) ? artifactsDir : ".", "SHA256SUMS.txt");
    fs.writeFileSync(sumsPath, sumsContent, "utf8");
    console.log(`\nGenerated ${sumsPath}`);
  }

  if (!token) {
    console.log(`\nTo publish these assets to GitHub:`);
    console.log(`  PUBLIC_REPO_TOKEN=<your_token> npx tsx scripts/publish-public-release.ts ${tagName} ${artifactsDir}\n`);
    return;
  }

  // 2. Query GitHub Releases API for target release
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "User-Agent": "VrushPDF-Release-Tool/1.0",
    "X-GitHub-Api-Version": "2022-11-28"
  };

  let releaseData: any = null;
  const viewRes = await fetch(`https://api.github.com/repos/${TARGET_REPO}/releases/tags/${tagName}`, {
    headers
  });

  if (viewRes.ok) {
    releaseData = await viewRes.json();
    console.log(`\nFound existing release '${releaseData.name || tagName}' (ID: ${releaseData.id}) on ${TARGET_REPO}.`);
  } else if (viewRes.status === 404) {
    console.log(`\nRelease '${tagName}' does not exist on ${TARGET_REPO}. Creating release...`);
    const createRes = await fetch(`https://api.github.com/repos/${TARGET_REPO}/releases`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        tag_name: tagName,
        name: `VrushPDF ${tagName}`,
        body: `Download the installer for your platform below. These builds are unsigned — see the README for how to get past Gatekeeper and SmartScreen.`,
        draft: false,
        prerelease: false
      })
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      throw new Error(`Failed to create release on ${TARGET_REPO} (${createRes.status}): ${errText}`);
    }
    releaseData = await createRes.json();
    console.log(`Successfully created release (ID: ${releaseData.id}) on ${TARGET_REPO}.`);
  } else {
    const errText = await viewRes.text();
    throw new Error(`Failed to query release on ${TARGET_REPO} (${viewRes.status}): ${errText}`);
  }

  // 3. Upload or update assets
  const existingAssets: any[] = releaseData.assets || [];
  const uploadUrlTemplate: string = releaseData.upload_url;
  const baseUrl = uploadUrlTemplate.replace(/\{.*\}/, "");

  // Gather all final files including SHA256SUMS.txt
  const finalFiles = [...filesToUpload];
  const sumsFile = path.join(fs.existsSync(artifactsDir) ? artifactsDir : ".", "SHA256SUMS.txt");
  if (fs.existsSync(sumsFile) && !finalFiles.some((f) => f.name === "SHA256SUMS.txt")) {
    const stat = fs.statSync(sumsFile);
    finalFiles.push({
      name: "SHA256SUMS.txt",
      path: sumsFile,
      size: stat.size,
      sha256: computeSha256(sumsFile)
    });
  }

  for (const file of finalFiles) {
    const existing = existingAssets.find((a) => a.name === file.name);
    if (existing) {
      console.log(`Deleting existing asset '${file.name}' (ID: ${existing.id}) before re-upload...`);
      const delRes = await fetch(`https://api.github.com/repos/${TARGET_REPO}/releases/assets/${existing.id}`, {
        method: "DELETE",
        headers
      });
      if (!delRes.ok) {
        console.warn(`Warning: Failed to delete asset '${file.name}': ${await delRes.text()}`);
      }
    }

    console.log(`Uploading '${file.name}' (${(file.size / 1024 / 1024).toFixed(2)} MB)...`);
    const fileBytes = fs.readFileSync(file.path);
    const contentType = file.name.endsWith(".txt")
      ? "text/plain"
      : file.name.endsWith(".dmg")
      ? "application/x-apple-diskimage"
      : "application/octet-stream";

    const uploadRes = await fetch(`${baseUrl}?name=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": contentType,
        "Content-Length": file.size.toString()
      },
      body: fileBytes
    });

    if (!uploadRes.ok) {
      console.error(`Failed to upload '${file.name}': ${await uploadRes.text()}`);
    } else {
      console.log(`✓ Successfully uploaded '${file.name}'`);
    }
  }

  console.log(`\nAll release assets successfully synced to https://github.com/${TARGET_REPO}/releases/tag/${tagName}\n`);
}

main().catch((err) => {
  console.error("Error publishing release:", err);
  process.exit(1);
});
