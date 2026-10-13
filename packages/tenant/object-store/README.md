# @deepseek-ai/dsh-object-store

对象存储发布。模型在沙箱里生成的文件只有沙箱看得见，而用户只通过业务前端访问该部署。本插件把文件写进部署方配置的 S3 兼容存储（Ceph RGW、MinIO、云对象存储都行），返回一条**不带凭据就能下载**的公开地址，并提供 `object_publish` 工具让模型拿到它。地址由用户的浏览器、前端的下载按钮或外部系统直接取用，不再经过沙箱，也不再经过本服务。

签名与寻址用官方 SDK（`@aws-sdk/client-s3`）：SigV4、路径式/虚拟主机式寻址、校验和与重试都是外部规范，由维护方跟随，本包只保留部署侧真正会变的部分——端点、桶、公开基址、凭据来源与大小上限。

存储本身用 Ceph 时，桶由 CephObjectStore 提供（rook 的 `CephObjectStore` + `CephObjectStoreUser`），公开性由桶策略给出——这是部署步骤，不是运行时配置：

```bash
# 桶策略只开放取对象，不开放枚举，因此知道键的人能下载，列不出桶里有什么。
s3.put_bucket_policy(Bucket='dsh-public', Policy=json.dumps({
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow", "Principal": {"AWS": ["*"]},
    "Action": ["s3:GetObject"], "Resource": ["arn:aws:s3:::dsh-public/*"],
  }],
}))
```

## 配置

```yaml
plugins:
  object-store:
    enabled: true
    config:
      endpoint: http://dsh-rgw-public.rook-ceph.svc:80   # 服务访问存储的地址
      bucket: dsh-public                                 # 已开放匿名只读的桶
      publicBaseUrl: http://192.168.138.130:30900        # 用户浏览器能到达的地址
      region: us-east-1                                  # RGW 默认 zonegroup
      accessKeyEnv: DSH_OBJECT_ACCESS_KEY                # 读密钥的环境变量名
      secretKeyEnv: DSH_OBJECT_SECRET_KEY
      forcePathStyle: true                               # RGW / MinIO 用路径式寻址
      keyPrefix: ''                                      # 对象键前缀，用来与同桶的其它对象分开
      maxBytes: 268435456                                # 单文件上限
      usersRoot: /opt/dsh/.dsh/users                     # /global 挂载对应的宿主根；没有该挂载时省略
      verifyPublic: true                                 # 写完之后匿名校验一次公开地址
```

`endpoint` 与 `publicBaseUrl` 是两个不同的地址：前者是本服务签名上传用的（集群内地址即可），后者是写进回复、给用户点的。两者写反不会报错但会产生取不到的链接；`verifyPublic: true` 会让这种情况在发布时就失败，而不是把死链交给模型。密钥只从环境变量读，配置里写的是变量名；变量缺失时服务在启动阶段就报错。

## 工具

| 工具 | 参数 | 结果 |
|---|---|---|
| `object_publish` | `file_path`（必填，绝对路径或相对工作目录）、`title`、`content_type` | `key`、`url`（公开地址）、`bytes`、`content_type`、`source_path` |

工具名是协议常量而不是配置项：业务前端从会话事件流里按 `object_publish` 取发布结果渲染下载项，而不是去读模型正文。模型的正文不可靠——实测它会声称「工具没返回 url」并自行拼一个取不到的地址。

结果的结构化字段同时投影进 `tool/result` 事件的 `meta`（`key`、`url`、`bytes`、`content_type`、`source_path`）。前端读 `meta` 即可渲染下载项：不必解析结果文本，更不必解析模型正文。`meta` 可 JSON 序列化，因此回放会话日志能还原出同一张卡片。

```
<keyPrefix><case>/<subject>/<YYYYmmdd_HHMMSS>_<stem>.<ext>
```

`title` 给的是主干，扩展名取自源文件；标题里带了与源文件相同的扩展名时那个扩展名会被去掉（模型常把整个文件名当标题传来），键不会变成 `sales.csv.csv`。

`content_type` 未给时按扩展名推断（docx / xlsx / pptx / pdf / html / md / txt / csv / json / xml / zip / png / jpg / gif / webp / svg），其余按 `application/octet-stream`。同一主体在同一秒内发布同名文件会各自得到自己的键（`_2`、`_3`……），因此并发发布不会覆盖。上传是新增对象、不是覆盖：再次发布产生新对象，源文件仍在工作目录里。

## 模型路径在哪里解析

本插件读取的是容器 provider 为调用主体绑定的同一批挂载，因此沙箱能写的路径恰好就是本工具能发布的路径：

| 模型写入 | 本插件读取的宿主路径 | 对象键 |
|---|---|---|
| `/workspace/<rel>` | `<tenant.workspaceRoot>/users/<subject>/<rel>` | `<case>/<subject>/…` |
| `/shared/<rel>` | `<tenant.workspaceRoot>/shared/<rel>` | `<case>/<subject>/…` |
| `/global/<rel>` | `<usersRoot>/<subject>/<rel>` | `<case>/<subject>/…` |

这些挂载之外的路径会被拒绝；解析出的文件在跟随符号链接之后还会被复查，因此挂载点内植入的链接读不到挂载之外。不存在的路径按不存在报告；宿主解析不了它时——权限被拒、符号链接成环、名字过长——报告的是那个失败。

## 隔离

发布被部署方所鉴权的两项请求权威限定两次：**案件**（`requireTenant()`）与**主体**（`requireUser()`）。一次调用只从调用主体的挂载读取，键里带案件与主体身份，因此主体既发布不了另一个主体的文件，也拿不到它的键。非案件作用域请求中的调用会明确失败，而不是回退到共享位置。

## Model Experience

### Publishing a generated file

#### What the model sees

`object_publish` 返回对象键、公开地址、字节数、写入的 `Content-Type` 与源路径，并明确要求把地址写进回复。给模型的那一行是 `[源文件名](公开地址)` 形式的 markdown 链接：前端按 markdown 渲染时它就是用户可以直接点的下载项，纯文本前端拿到的仍是同一条地址。路径不在主体挂载之内、文件不存在、不是普通文件、超过上限、存储拒写、以及写完之后公开地址取不到，都会让调用失败并说明原因；不存在「返回成功但没上传」的结果。

#### Token effect

工具 schema 常驻（约 160 token）。每次调用增加一条简短结果：对象键、地址、大小与类型。

#### KV Cache effect

仅追加；结果跟在可复用的请求前缀之后。

## Known Limitations and Deferred Work

- **整个文件进内存。** 上传先 `readFile` 再交给客户端 PUT，因此上限受本服务内存约束；GB 级文件需要改成分片上传。
- **没有列举与删除工具。** 模型只能发布；对象键由返回值与桶里的键前缀决定，清理靠存储侧的生命周期规则。
- **公开性只在发布时校验一次。** 桶策略后来被改窄，已经发出去的地址会失效，本服务不追踪也不重试。
- **桶与桶策略不由本服务创建。** 建桶、开匿名只读、配生命周期都是部署步骤（见上面的策略片段）；服务只写对象。
- **宿主必须与沙箱看到同一份存储。** 本插件按宿主路径读取文件，因此部署要把沙箱工作区所在的那份存储（PVC 或目录）挂到配置里的 `workspaceRoot` / `usersRoot` 上。挂的是另一棵树时表现为「文件在沙箱里确实存在，工具却报不存在」——沙箱内的 `/workspace`、`/shared`、`/global` 来自 PVC 的 `tenants/<案件>/workspace/{users/<主体>,shared}`，而宿主侧同样路径指向文件系统另一处。
- **权威地址在工具结果里，不在模型回复里。** 结果已经把地址写成可直接点的 markdown 链接并要求原样照抄，但模型仍可能改写它（实测出现过自己编一个更好看的域名）。业务前端渲染下载项时应以工具结果里的 `url` 字段为准，不要把回复正文里的地址当作唯一来源。
- **秘密地址不等于授权。** 任何知道键的人都能下载；需要按用户鉴权的下载要在存储侧签名或由业务前端代理。
