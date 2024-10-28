import { Client } from "@notionhq/client";
import { NotionToMarkdown } from "notion-to-md";
import fs from 'fs';
import readingTime from 'reading-time';
import { config } from 'dotenv';
import { parseArgs } from 'node:util';
import { sanitizeUrl, sanitizeImageString } from './helpers/sanitize.mjs';
import { hashString, downloadImage } from './helpers/images.mjs';
import { delay } from './helpers/delay.mjs';
import path from "path";

// Input Arguments
const ARGUMENT_OPTIONS = {
  published: { // Only sync published posts
    type: 'boolean',
    short: 'p'
  },
};
const { values: { published } } = parseArgs({ options: ARGUMENT_OPTIONS });
const isPublished = !!published;
console.log(`Syncing Published Only: ${isPublished}`)

// Load ENV Variables
config();
if (!process.env.NOTION_KEY || !process.env.DATABASE_ID) throw new Error("Missing Notion .env data")
const NOTION_KEY = process.env.NOTION_KEY;
const DATABASE_ID = process.env.DATABASE_ID; // TODO: Import from ENV

const POSTS_PATH = `src/pages/posts`;
const THROTTLE_DURATION = 334; // ms Notion API has a rate limit of 3 requests per second, so ensure that is not exceeded

const notion = new Client({
  auth: NOTION_KEY,
  config: {
    parseChildPages: false,
  }
});

// Notion Custom Block Transform START
const n2m = new NotionToMarkdown({ notionClient: notion });
n2m.setCustomTransformer("embed", async (block) => {
  const { embed } = block;
  if (!embed?.url) return "";
  return `<figure>
  <iframe src="${embed?.url}"></iframe>
  <figcaption>${await n2m.blockToMarkdown(embed?.caption)}</figcaption>
</figure>`;
});

n2m.setCustomTransformer("image", async (block) => {
  const { image } = block;
  console.info("Image Block:", image);
  const imageUrl = image?.file?.url || image?.external?.url;
  const alt = image?.caption?.[0]?.plain_text || 'CDV Group Valve Image is loading';
  return `![${alt}](${imageUrl})`;
});

n2m.setCustomTransformer("video", async (block) => {
  const { video } = block;
  const { caption, type, external: { url: videoUrl } } = video;

  let url = videoUrl;

  if (url.includes('youtube.com')) {
    if (url.includes('/watch')) {
      // Youtube URLs with the /watch format don't work, need to be replaced with /embed
      const videoId = url.split('&')[0].split('?v=')[1];
      url = `https://www.youtube.com/embed/${videoId}`;
    }
  }

  return `<iframe width="100%" height="480" src="${url}" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>`
});
// Notion Custom Block Transform END

// Fetch Notion Posts from Database via Notion API
const queryParams = {
  database_id: DATABASE_ID,
}

if (isPublished) {
  queryParams.filter = {
    "and": [
      {
        "property": "status",
        "select": {
          equals: 'published'
        }
      },
    ]
  }
}

const databaseResponse = await notion.databases.query(queryParams);
const { results } = databaseResponse;
const defaultDocLocale = 'en';
// Create Pages
const pages = results.map((page) => {
  const { properties, cover, created_time, last_edited_time, icon, archived } = page;
  const title = properties.title.title[0].plain_text || "Untitled";
  const slug = properties?.slug?.rich_text[0]?.plain_text || sanitizeUrl(title)

  let locale = properties.locale?.select?.name || '';
  // get the locale from the page properties, if the collection  is `docs` then compare the locale with the defaultDolocale, if locale is same as defaultDocLocale then set the locale to `''`
  if (properties.collection?.select?.name === 'docs' && properties.locale?.select?.name === defaultDocLocale) {
     locale = '';
  } 

  console.info("Notion Page:", page);

  return {
    id: page.id,
    title,
    type: page.object,
    cover: cover?.external?.url || cover?.file?.url,
    // tags: properties.tags.multi_select,// tags like this `[{"id":"ee932bde-0023-446f-9bb4-17d2022121c9","name":"文字","color":"brown"},{"id":"d9f66761-0396-4e80-be5c-2ab6c7f8ba86","name":"推荐","color":"red"}]`, need to be parsed into array with names
    tags: properties.tags.multi_select.map(tag => tag.name),
    collection: properties.collection?.select?.name || 'etc',
    created_time,
    last_edited_time,
    icon,
    locale: locale,
    archived,
    category: properties.category?.select?.name || 'unknown',
    status: properties?.status?.select?.name,
    publish_date: properties?.publish_date?.date?.start,
    description: properties?.description?.rich_text[0]?.plain_text,
    slug,
  }
});

for (let page of pages) {
  console.info("Fetching from Notion & Converting to Markdown: ", `${page.title} [${page.id}]`);
  const mdblocks = await n2m.pageToMarkdown(page.id);
  const { parent: mdString } = n2m.toMarkdownString(mdblocks);

  const estimatedReadingTime = readingTime(mdString || '').text;

  // Download Cover Image
  const coverFileName = page.cover ? await downloadImage(page.cover, { isCover: true }) : '';
  if (coverFileName) console.info("Cover image downloaded:", coverFileName)

  // Generate page contents (frontmatter, MDX imports, + converted Notion markdown)
  const pageContents = `---
id: "${page.id}"
type: "${page.type}"
slug: "${page.slug}"
title: "${page.title}"
cover: "${page.cover}"
coverAlt: "${page.title}"
coverFileName: "${coverFileName}"
tags: ${JSON.stringify(page.tags)}
created_time: ${page.created_time}
last_edited_time: ${page.last_edited_time}
icon: ${JSON.stringify(page.icon)}
archived: ${page.archived}
category: ${page.category}
locale: "${page.locale}"
status: "${page.status}"
publish_date: ${page.publish_date ? page.publish_date : false}
description: "${page.description === 'undefined' ? '' : page.description}"
reading_time: "${estimatedReadingTime}"
---

${mdString}
`


// create the path if it doesn't exist
if (!fs.existsSync(`${process.cwd()}/src/content/${page.collection}/${page.locale}`)) {
  fs.mkdirSync(`${process.cwd()}/src/content/${page.collection}/${page.locale}`, { recursive: true });
}

  if (mdString) fs.writeFileSync(`${process.cwd()}/src/content/${page.collection}/${page.locale}/${page.slug}.md`, pageContents);
  else console.log(`No content for page ${page.id}`)

  console.debug(`Sleeping for ${THROTTLE_DURATION} ms...\n`)
  await delay(THROTTLE_DURATION); // Need to throttle requests to avoid rate limiting
}

console.info("Successfully synced posts with Notion")
