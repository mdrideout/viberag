# VibeRAG - Local Code RAG MCP Server

VibeRAG is a React Ink / Typescript CLI and MCP server for local codebase RAG. 

Powered by LanceDB, it leverages LanceDB's advanced querying capabilities for local semantic search, BM25, keyword search, fuzzy matching, etc. for AI agents.

The goal is to create an easy to manage MCP server with an advanced CLI interface for initialization, a search interface, and agentic interaction with codebase files. The MCP capabilities will make it easy for AI Agents to find relevant code in large codebases, including.

It includes an interactive CLI powered by React Ink that makes it easy to setup, initialize, observe, and interact with the codebase indexing, as well as execute search queries manually.

The MCP server is built with the [node implementation of FastMCP]...

### Greenfield

This is a greenfield project. Deprecations, migrations, backward compatibility are not required. We can completely reset all data at any time and re-initialize fresh. 

### Prepare to Work

Review the following files to understand the project, progress, and what's next.

- Analyze the folder structure and file names
- @package.json - analyze packages in use
  - When working, use context7 to check library docs to ensure the latest syntax and use.

## Important Library Documentation:

Use context7 to perform RAG on libraries and documentation to ensure you are using the LATEST and CORRECT syntax, and to get examples. You need to adhere to the patterns and opinions of the frameworks. Do not attempt to improvise. Find documentation to support your architecture decisions.

## Libraries:

- LanceDB (nodejs) - the vector databases used by Lance Code RAG. Ensure you search for nodejs specific documentation and examples.
  - github: - https://github.com/lancedb/lancedb
  - website docs: https://docs.lancedb.com/
  - context7 github: https://context7.com/lancedb/lancedb
  - context7 website docs: https://context7.com/websites/lancedb

- Ink:
  - github: https://github.com/vadimdemedes/ink
  - context7: https://context7.com/vadimdemedes/ink

- FastMCP (TypeScript):
  - github: https://github.com/punkpeye/fastmcp
  - context7: https://context7.com/punkpeye/fastmcp 

## Example CLI Apps:

- Claude Code (built with Ink)
  - github: https://github.com/anthropics/claude-code
  - context7: https://context7.com/anthropics/claude-code

- Gemini CLI (built with Ink)
  - github: https://github.com/google-gemini/gemini-cli
  - context7: https://context7.com/google-gemini/gemini-cli

## Architecture Overview

This is a codebase that will scale with more features very rapidly. We architect and build code using good conventions for scale. We will not wait to refactor when we feel pain, we will use good conventions today.

Review all files inside @adr/ to understand architectural decisions.

## Code Style

Use Grug development principles, such as single responsibility principle, principle of least astonishment, YAGNI (as it pertains to over-engineered abstractions and "systems"), and KISS.

Examples: use naked functions over unnecessary classes and abstractions. 

**However**, you align with the recommended patterns of the libraries and frameworks if any conflict with Grug.

## Package Management:

- Install packages with `npm install [package]` - do not specify versions, get the latest every time.
- Never make git commits until I explicitly instruct you to do so.

## Testing:

- Avoid pointless unit tests
- Focus on critical P0 integration tests to help validate functionality and avoid regressions
- When to sparingly create tests:
  - Create integration tests when failures are encountered that we want to ensure we do not create regressions on.
  - Create integration tests for critical contracts between system components.

## Exception Handling:

- Handle exceptions clearly and transparently.
- Never obfuscate exceptions, ensure they are visible in the UX and logs, and can be copied / pasted for debugging and reference.
- Log every session to a gitignored .log file, sorted by date.

## Agent Chat Style

- The chat window width is limited, when consturcting tables and diagrams, assume a maximum width of 180 characters. 