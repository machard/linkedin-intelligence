# LinkedIn Intelligence

## Overview
LinkedIn Intelligence is a Node.js-based project designed to automate interactions with LinkedIn using Puppeteer, a library for controlling headless browsers. The project extracts data from LinkedIn posts and transforms them into Hugo gallery items, enabling seamless integration with static site generators.

## Features
- Automates browser interactions using Puppeteer.
- Extracts LinkedIn post data.
- Downloads images from LinkedIn posts.
- Generates Hugo gallery items for static site integration.

## File Structure
- `linkedin-intelligence.js`: Main script for data extraction and transformation.
- `package.json`: Contains project dependencies and metadata.
- `public/`: Directory containing generated gallery items, images, and other public assets.
- `puppeteer-session/`: Directory storing Puppeteer session data.
- `themes/`: Directory for Hugo themes.

## Installation
1. Clone the repository.
2. Run `npm install` to install dependencies.

## Usage
1. Ensure Puppeteer is properly configured.
2. Run the script `linkedin-intelligence.js` with the `--extractPosts` flag to extract LinkedIn posts, download images, and generate Hugo gallery items.
3. Generated images will be stored in the `public/images` directory.
4. Hugo gallery items will be stored in the `public/gallery` directory.

## Notes
- The `.gitignore` file excludes `node_modules`, `puppeteer-session`, and other temporary files from version control.
- Ensure compliance with LinkedIn's terms of service when using this tool.

## License
This project is licensed under the MIT License.