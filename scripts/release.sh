#!/bin/bash
set -e

# Get date components, stripping leading zeros to comply with SemVer
YEAR=$(date +%Y)
MONTH=$(date +%m | sed 's/^0//')
DAY=$(date +%d | sed 's/^0//')

VERSION="$YEAR.$MONTH.$DAY"

# Check if tag exists
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  echo "Tag v$VERSION already exists."
  
  # If tag exists, try to find a sub-version?
  # Since we used all 3 slots (Major.Minor.Patch) for the date, we can't easily add a 4th number.
  # We could use a pre-release tag like -1, -2 but that makes it "older" than the base.
  # We could use build metadata +1, but that is ignored for precedence.
  
  # Alternative: If we really need multiple releases per day, we might need to change the scheme.
  # But for "Tagesdatum" (Daily Date), usually one per day is implied.
  
  echo "Error: Release for today already exists. Manual intervention required."
  exit 1
fi

echo "Bumping version to $VERSION..."

# Update package.json without creating a git tag yet (we do it manually to control the message/format)
npm version $VERSION --no-git-tag-version

# Commit the change
git add package.json
git commit -m "chore: release v$VERSION"

# Create the tag
git tag -a "v$VERSION" -m "Release v$VERSION"

echo "------------------------------------------------"
echo "Release v$VERSION created successfully."
echo "Run the following command to push changes and trigger the release workflow:"
echo ""
echo "  git push --follow-tags"
echo "------------------------------------------------"
