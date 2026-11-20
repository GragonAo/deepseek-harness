# Agent Note: 部署就是 helm 加手敲命令，没有脚本工具包

Status: implemented

[English](2026-11-20-helm-only-deployment.md) | 中文

在重叠的部分，本记录取代[部署 provider 注册表](../architecture/2026-11-07-deployment-provider-registry.md)里对部署脚本的假设；那份记录仍然描述运行时注册表，而不是集群怎么铺开。

## Problem

五个仓库共用一套部署工具包：一份 `deploy-kit` 检出里的 shell 入口、按站点分的 env 文件、chart 到站点的键名映射、镜像锁文件，还有一层 verify 包装脚本。它和它驱动的 chart 一起漂移了。`helm-site-map.txt` 里写着 chart 早就改名的取值键；`images.lock` 钉住的 tag 和任何 chart 默认值都对不上；verify 包装跑的 `kubectl diff` 比对的对象名只存在于某个站点的 env 文件里。对一台从没部署过的机器，表现每次都一样：有人照着文档做，包装脚本跑出一串没人看得懂的 `helm` 调用，故障在 Pod 启动三十秒后才冒出来，而不是在第一次 `helm upgrade` 之前。

两笔具体代价，都真实发生过：

- 包装脚本藏起了是哪个 chart 版本、哪个取值文件、哪条 `--set` 产生了一个 release。想复现一个正在跑的集群，得读 shell 反推命令行。
- 删一个包装脚本就等于删掉一段知识。文件早就没了，文档还在指向 `sync-nacos-config.sh`、`ceph-s3-secret.sh`、`up.sh`、`deploy.sh`，照文档做走不通，真正的做法只活在某个人的终端历史里。

工具包也是 chart 默认值可以一直错着的原因：既然包装脚本总会传 `--set`，就没人发现 `config.tenantConfig.volumeKind` 的默认种类根本不是 chart 会创建的那个（见[租户配置正文是部署机自己的 Secret](../architecture/2026-11-20-tenant-config-secret-by-default.md)）。

## Alternatives considered

- **保留工具包，和 chart 重新对齐一次。** 否决：失效模式就是漂移，多对齐一次治不了漂移；而且一次 `helm upgrade` 仍然有两个真源。
- **换成每仓一个 `Makefile` / `Taskfile`。** 否决：同一个形状，只是换了个藏东西的地方。一个叫 `deploy` 的 task 照样把参数藏起来，各仓还会按各自习惯再次分叉。
- **上 GitOps 控制器（Argo CD / Flux），从 chart 渲染。** 现阶段否决：长期来看是对的形状，但它需要控制器、仓库布局和一套凭据方案，这个环境三样都没有。而且眼下的问题是"看不懂"，不是"不够自动"。
- **保留脚本，但让参数从 chart 生成。** 否决：生成解决了参数清单，留着包装层，机器上真正跑过的命令依然不可见。

## Decision

`deploy-kit` 从每个仓库删除。部署变成：

- **目标机器上放物料**，一个版本一个目录：`/opt/icac-ai-helm/<版本>/{charts,values,images,nacos-config,assets}`。chart 就是各仓自己的 `deploy/helm/*` 目录，中间不做任何转换。
- **站点取值只活在机器上**，权限 600，绝不进 git。一个站点的真 token 和口令，在仓库里没有任何表示。
- **文档里写的就是人手敲的命令块**：`ctr -n k8s.io images import`、`helm upgrade --install … --take-ownership --wait`、`kubectl rollout restart`、Nacos 控制台导 zip。每一行自己带着自己的参数，读一遍就能复现。
- **chart 默认值必须自己站得住。** 一个不带任何 `--set` 的新环境，要么能起来，要么在渲染期就失败，绝不允许在 Pod 启动时才失败。租户配置卷的默认值就是在这次一并改正的。

以前写着脚本名的文档，现在写动作和它的键名材料——例如对象存储凭据按键名（`CEPH_S3_ACCESS_KEY` / `CEPH_S3_SECRET_KEY`）描述，而不是按"当初创建这个 Secret 的脚本"描述。

## Consequences

- 铺一个版本是每个 release 五条要敲的命令，敲的人能看见每一个参数。没有 `deploy.sh` 可跑，也没有 `--atomic`（首次安装失败会把它接管过来的对象一起卸掉）。
- 镜像搬运没有自动化：文档给的是 `sha256sum -c` 然后 `ctr images import` 的循环，因为集群够不到镜像仓库。
- chart 默认值现在承重。默认值写错，会被下一个铺新环境的人发现；也就是说默认值要接受过去被包装脚本挡掉的那份审视。
- 每个仓的文档都必须自成一体：不许引用别仓的路径，假装它就在读者盘上。反复要问的一句话是"只有这几个仓的机器上，这句话能用吗？"

## References

- [租户配置正文是部署机自己的 Secret](../architecture/2026-11-20-tenant-config-secret-by-default.md)
- [共享资产卷整块挂载](../architecture/2026-11-20-whole-claim-asset-mount.md)
- [Chart README：安装、升级、租户配置](../../../../deploy/helm/deepseek-harness/README.md)