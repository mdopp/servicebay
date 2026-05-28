import unittest
import sys
import os
from unittest.mock import patch

# Add current dir to path to import agent
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

# Mock shutil.which before import (agent checks for 'ss' at import time).
with patch('shutil.which', return_value='/bin/ss'):
    import agent


class TestSplitImageRef(unittest.TestCase):
    """`_split_image_ref` feeds the docker-compat /images/create endpoint,
    which takes fromImage + tag separately."""

    def test_registry_repo_tag(self):
        self.assertEqual(agent._split_image_ref('docker.io/ollama/ollama:latest'),
                         ('docker.io/ollama/ollama', 'latest'))

    def test_defaults_tag_to_latest_when_absent(self):
        self.assertEqual(agent._split_image_ref('docker.io/library/alpine'),
                         ('docker.io/library/alpine', 'latest'))

    def test_registry_port_is_not_mistaken_for_tag(self):
        self.assertEqual(agent._split_image_ref('localhost:5000/foo/bar:1.2'),
                         ('localhost:5000/foo/bar', '1.2'))

    def test_registry_port_without_tag(self):
        self.assertEqual(agent._split_image_ref('localhost:5000/foo'),
                         ('localhost:5000/foo', 'latest'))

    def test_digest_pin_passes_whole_ref_with_no_tag(self):
        ref = 'ghcr.io/mdopp/servicebay@sha256:' + 'a' * 64
        self.assertEqual(agent._split_image_ref(ref), (ref, None))


if __name__ == '__main__':
    unittest.main()
