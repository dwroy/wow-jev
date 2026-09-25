import pytest

from jevbridge import capture


@pytest.fixture(scope="session")
def exe():
    if not capture.available():
        pytest.skip("没有 capture/bin/JevCapture.exe，先运行 ./capture/build.sh")
    return capture
