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
  
  # If tag exists, we increment the "Day" (Patch) component.
  # This results in dates like 2025.12.32, which are invalid calendar dates
  # but valid SemVer and ensure correct upgrade precedence.
  COUNTER=1
  while git rev-parse "v$YEAR.$MONTH.$(($DAY + $COUNTER))" >/dev/null 2>&1; do
    COUNTER=$(($COUNTER + 1))
  done
  
  NEW_DAY=$(($DAY + $COUNTER))
  VERSION="$YEAR.$MONTH.$NEW_DAY"
  echo "Resolved conflict. New version: $VERSION"
fi

echo "Bumping version to $VERSION..."

# Update package.json without creating a git tag yet (we do it manually to control the message/format)
npm version $VERSION --no-git-tag-version

# Commit the change
git add package.json package-lock.json
git commit -m "chore: release v$VERSION"

# Create the tag
git tag -a "v$VERSION" -m "Release v$VERSION"

echo "------------------------------------------------"
echo "Release v$VERSION created successfully."
echo "Run the following command to push changes and trigger the release workflow:"
echo ""
echo "  git push --follow-tags"
echo "------------------------------------------------"
