class AgentMemory < Formula
  desc "agentmemory CLI: persistent memory for coding agents with qmd semantic search"
  homepage "https://github.com/jayzeng/agentmemory"
  url "https://github.com/jayzeng/agentmemory/archive/refs/tags/v0.5.0.tar.gz"
  sha256 "76e840b923a955d6f4be40dec481ec2187757f3414a84590d4b8570a69ac5eba"
  version "0.5.0"
  license "MIT"

  depends_on "bun" => :build

  def install
    system "bun", "build", "src/cli.ts",
      "--compile",
      "--outfile", "agent-memory",
      "--define", "__VERSION__=\"'#{version}'\""

    libexec.install "skills"
    libexec_bin = libexec/"bin"
    libexec_bin.install "agent-memory"
    bin.env_script_all_files(libexec_bin, AGENT_MEMORY_SKILLS_ROOT: libexec)
  end

  test do
    system "#{bin}/agent-memory", "status"
  end
end
